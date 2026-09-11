/**
 * DefaultToolGateway — the v2 enforcement pipeline (ToolGateway doc §5).
 *
 * Consumes the immutable EffectivePolicy snapshot from derive() and executes
 * the 11 stages in order. Every stage emits an audit event; failures are
 * structured (V13 fail-closed). The gateway never computes policy, never
 * resolves handles from args (N4) and never widens the snapshot.
 */

import { ulid } from '../id.js';
import { egressCheck } from './dataflow.js';
import { isStrictlyWider } from './escalation.js';
import {
    type ApprovalDecision,
    type ApprovalRequest,
    GATEWAY_PIPELINE_STAGES,
    type GatewayBindInput,
    type GatewayStage,
    type HookContext,
    type InvocationRequest,
    type InvocationResult,
    type SessionApproval,
    type ToolGateway,
    type ToolRegistration,
    type ToolSpec,
    type ValueProjection,
} from './gateway-types.js';
import { matchGlob, normalizeAssetPath } from './glob.js';
import { buildAttestationText, type EgressAttestation } from './ledger.js';
import { isWriteAction, strictestTier } from './rules.js';
import type { CapabilityToken, SignedRequest } from './secret-ref.js';
import type { AuthzErrorCode, CapabilityKey, CapabilityRule, EffectTier } from './types.js';
import { matchVerb } from './verbs.js';

/** Default value projector: reads args by the declared param names. */
export function projectValues(
    args: Record<string, unknown>,
    projection: ToolRegistration['scope'],
): ValueProjection {
    const out: ValueProjection = {};
    const firstString = (names?: readonly string[]): string | undefined => {
        for (const name of names ?? []) {
            const value = args[name];
            if (typeof value === 'string' && value.length > 0) return value;
        }
        return undefined;
    };
    const path = firstString(projection.pathParams);
    if (path !== undefined) out.path = path;
    const host = firstString(projection.hostParams);
    if (host !== undefined) out.host = host;
    if (projection.amountParam !== undefined) {
        const raw = args[projection.amountParam];
        if (typeof raw === 'number') {
            out.amount = { currency: 'USD', amount: raw };
        } else if (raw && typeof raw === 'object' && 'amount' in raw) {
            out.amount = raw as { currency: string; amount: number };
        }
    }
    const command = firstString(projection.commandParam ? [projection.commandParam] : undefined);
    if (command !== undefined) out.command = command;
    const sql = firstString(projection.sqlParam ? [projection.sqlParam] : undefined);
    if (sql !== undefined) out.sql = sql;
    return out;
}

/** Scope hit: every projected value must fall inside the effective rule's range. */
export function isInScope(projection: ValueProjection, rule: CapabilityRule): boolean {
    if (
        projection.path !== undefined &&
        rule.paths !== undefined &&
        !rule.paths.some((pattern) =>
            matchGlob(normalizeAssetPath(pattern), normalizeAssetPath(projection.path as string)),
        )
    ) {
        return false;
    }
    if (
        projection.host !== undefined &&
        rule.hosts !== undefined &&
        !rule.hosts.some((pattern) => matchGlob(pattern, projection.host as string))
    ) {
        return false;
    }
    if (
        projection.amount !== undefined &&
        rule.amountLimit !== undefined &&
        projection.amount.amount > rule.amountLimit.amount
    ) {
        return false;
    }
    return true;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class DefaultToolGateway implements ToolGateway {
    readonly stageNames = GATEWAY_PIPELINE_STAGES;
    private readonly sessionApprovals: SessionApproval[] = [];
    private generationAttestation?: EgressAttestation;
    private stepsUsed = 0;
    private readonly now: () => number;

    constructor(private readonly bind: GatewayBindInput) {
        this.now = bind.now ?? (() => Date.now());
    }

    /** Session/workspace/generation approvals in effect for this task. */
    approvals(): readonly SessionApproval[] {
        return this.sessionApprovals;
    }

    async invoke(req: InvocationRequest): Promise<InvocationResult> {
        const registration = this.bind.toolRegistry.get(req.tool);
        const stepId = req.stepId ?? ulid();
        const identifiers = {
            ...this.bind.identifiers,
            ...(req.taskId ? { taskId: req.taskId } : {}),
            stepId,
        };
        const emit = (
            stage: GatewayStage,
            decision: 'allowed' | 'denied' | 'pending' | 'info',
            extra: {
                capability?: CapabilityKey;
                detail?: string;
                ruleId?: string;
                code?: AuthzErrorCode;
            } = {},
        ): void => {
            this.bind.audit.log({ stage, decision, identifiers, tool: req.tool, ...extra });
        };
        const reject = (
            code: AuthzErrorCode,
            hint: string,
            stage: GatewayStage,
            ruleId?: string,
        ): InvocationResult => {
            emit(stage, 'denied', { code, detail: hint, ...(ruleId ? { ruleId } : {}) });
            return ruleId
                ? { kind: 'rejected', code, hint, ruleId }
                : { kind: 'rejected', code, hint };
        };

        // ① escalation-short-circuit (V12)
        let escalationWider = false;
        if (req.escalation && registration) {
            const effectiveRule = this.effectiveRule(registration.capability);
            escalationWider =
                effectiveRule !== undefined &&
                isStrictlyWider(req.escalation.requested, effectiveRule);
        }
        emit('escalation-short-circuit', 'info', {
            detail: req.escalation
                ? escalationWider
                    ? 'strictly-wider'
                    : 'short-circuited-non-wider'
                : 'no-escalation',
        });

        // ② supply-check (V5 closed-world)
        if (!registration) {
            return reject('FORBIDDEN_UNREGISTERED', `工具未注册：${req.tool}`, 'supply-check');
        }
        const required = (registration.parameters as { required?: string[] }).required ?? [];
        const missing = required.filter((key) => req.args[key] === undefined);
        if (missing.length > 0) {
            return reject('INVALID_ARGS', `缺少必填参数：${missing.join(', ')}`, 'supply-check');
        }
        emit('supply-check', 'allowed');

        const caps: CapabilityKey[] = [
            registration.capability,
            ...(registration.coCapabilities ?? []),
        ];
        const projection =
            this.bind.project?.(req.args, registration.scope) ??
            projectValues(req.args, registration.scope);
        const toolSpec = this.toolSpec(registration);

        // ③ hook-chain (V14 deny is absorbing)
        for (const hook of this.bind.hooks ?? []) {
            const context: HookContext = {
                tool: toolSpec,
                args: req.args,
                projection,
                identifiers,
                approvals: this.sessionApprovals,
            };
            const verdict = await hook.preExecute(context);
            if (verdict.verdict === 'deny') {
                return reject(verdict.code, verdict.hint, 'hook-chain');
            }
        }
        emit('hook-chain', 'allowed');

        // ④ tier-dispatch (joint over capability + coCapabilities)
        let tier: EffectTier = 'auto';
        for (const capability of caps) {
            const effective = this.bind.effective.capabilities[capability];
            if (!effective) {
                return reject('FORBIDDEN_BY_POLICY', `能力未授予：${capability}`, 'tier-dispatch');
            }
            if (effective.tier === 'forbidden') {
                return reject('FORBIDDEN_BY_POLICY', `能力被禁止：${capability}`, 'tier-dispatch');
            }
            tier = strictestTier(tier, effective.tier);
        }
        if (registration.trust === 'full') {
            tier = strictestTier(tier, 'gated');
            emit('tier-dispatch', 'info', { detail: 'full-trust-invocation' });
        }
        let needsApproval = tier === 'gated' || escalationWider;
        emit('tier-dispatch', 'info', { detail: `tier=${tier}` });

        // ⑤ scope-check: value-layer labels + R3-flow condition + outbound check
        const primary = this.bind.effective.capabilities[registration.capability];
        if (primary && projection.path !== undefined) {
            const staticLabel = this.bind.engine.resolveStatic({
                kind: 'path',
                value: projection.path,
            });
            if (staticLabel.label === 'secret' && isWriteAction(primary.rule.action)) {
                return reject('FORBIDDEN_BY_HARD_LAYER', 'V17: secret 资产写入禁止', 'scope-check');
            }
        }
        if (primary && !isInScope(projection, primary.rule)) {
            needsApproval = true;
            emit('scope-check', 'info', { detail: 'scope-miss' });
        }
        for (const capability of caps) {
            const verdict = this.bind.engine.judgeCondition(capability);
            if (verdict === 'broken') {
                needsApproval = true;
                emit('scope-check', 'info', { capability, detail: 'condition-broken' });
            } else if (verdict === 'satisfied') {
                emit('scope-check', 'info', { capability, detail: 'condition-satisfied' });
            }
        }
        if (registration.dataEgress) {
            const check = egressCheck({
                args: req.args,
                snapshot: this.bind.engine.ledger.snapshot(),
            });
            if (check.verdict === 'handle-rejected') {
                return reject(
                    check.code ?? 'HANDLE_UNRESOLVABLE',
                    check.hint ?? '出站 args 含句柄',
                    'scope-check',
                );
            }
            if (check.verdict === 'sensitive') {
                needsApproval = true;
                emit('scope-check', 'info', { detail: 'egress-sensitive' });
            }
        }
        if (
            needsApproval &&
            registration.role.transfer === 'egress' &&
            this.generationAttestation &&
            this.bind.engine.isAttestationValid(this.generationAttestation)
        ) {
            needsApproval = false;
            emit('scope-check', 'info', { detail: 'generation-attestation-valid' });
        }
        if (
            needsApproval &&
            this.sessionApprovals.some((a) => a.capability === registration.capability)
        ) {
            needsApproval = false;
            emit('scope-check', 'allowed', { detail: 'session-approval-hit' });
        }
        if (!needsApproval) {
            emit('scope-check', 'allowed');
        }

        // ⑥ danger-match
        for (const rule of this.bind.dangerRules ?? []) {
            if (!rule.appliesTo.some((capability) => caps.includes(capability))) continue;
            if (rule.outcome === 'forbidden') {
                return reject('FORBIDDEN_BY_DANGER_RULE', rule.reason, 'danger-match', rule.ruleId);
            }
            needsApproval = true;
            emit('danger-match', 'info', { ruleId: rule.ruleId, detail: rule.reason });
        }
        if (projection.command !== undefined) {
            const verbs = matchVerb(projection.command, projection.sql);
            if (verbs.length > 0) {
                needsApproval = true;
                emit('danger-match', 'info', {
                    detail: `danger-verb:${verbs.map((v) => v.verb).join(',')}`,
                });
            } else {
                emit('danger-match', 'allowed');
            }
        } else {
            emit('danger-match', 'allowed');
        }

        // ⑦ approval
        if (needsApproval) {
            if (!this.bind.approval) {
                return reject(
                    'APPROVAL_UNAVAILABLE',
                    '无审批 seam：gated 调用 fail-closed（V13）',
                    'approval',
                );
            }
            const invocationId = ulid();
            const request: ApprovalRequest = {
                invocationId,
                tool: req.tool,
                capability: registration.capability,
                echo: this.buildEcho(req, registration, projection, invocationId),
                identifiers,
            };
            emit('approval', 'pending', { detail: 'approval-requested' });
            const decision = await this.bind.approval.decide(request);
            const settled = this.settle(decision, registration.capability);
            if (settled) return reject(settled.code, settled.hint, 'approval');
            emit('approval', 'allowed', { detail: decision.decision });
        } else {
            emit('approval', 'allowed', { detail: 'not-required' });
        }

        // ⑧ budget
        this.stepsUsed += 1;
        const stepLimit = this.bind.budget?.steps;
        if (stepLimit !== undefined && this.stepsUsed > stepLimit) {
            return reject('BUDGET_EXHAUSTED', `步数预算耗尽（${stepLimit}）`, 'budget');
        }
        emit('budget', 'info', { detail: `steps=${this.stepsUsed}` });

        // ⑨ execute (+ secret-ref resolution; handler never touches wire format)
        const credentials = this.resolveSecrets(registration, req);
        if ('code' in credentials) {
            return reject(credentials.code, credentials.hint, 'execute');
        }
        let output: { value: unknown; untrusted?: boolean };
        try {
            output = await registration.handler(req.args, {
                signal: new AbortController().signal,
                ...(credentials.credentials ? { credentials: credentials.credentials } : {}),
            });
        } catch (error) {
            emit('execute', 'denied', { detail: errorMessage(error) });
            return { kind: 'failed', error: errorMessage(error), code: 'EXECUTION_FAILED' };
        }
        for (const hook of this.bind.hooks ?? []) {
            await hook.postExecute?.({
                tool: toolSpec,
                args: req.args,
                projection,
                identifiers,
                approvals: this.sessionApprovals,
                result: output,
            });
        }
        emit('execute', 'allowed');

        // ⑩ output-taint + ledger write + derived-label overlay
        const untrusted = registration.untrustedOutput === true || output.untrusted === true;
        if (registration.role.transfer === 'ingest' || registration.role.transfer === 'egress') {
            this.bind.engine.commitFlow({
                label: primary?.targetLabel ?? 'internal',
                source: registration.capability,
                stepId,
                transferDir: registration.role.transfer,
                severed: (registration.severance ?? 'plain') !== 'plain',
            });
        }
        if (primary && isWriteAction(primary.rule.action) && projection.path !== undefined) {
            this.bind.engine.applyWrite(projection.path);
        }
        emit('output-taint', 'allowed', { detail: untrusted ? 'untrusted' : undefined });

        // ⑪ audit
        emit('audit', 'allowed', { detail: 'executed' });
        return untrusted
            ? { kind: 'executed', value: output.value, untrusted: true }
            : { kind: 'executed', value: output.value };
    }

    private effectiveRule(capability: CapabilityKey): CapabilityRule | undefined {
        return this.bind.effective.capabilities[capability]?.rule;
    }

    private toolSpec(registration: ToolRegistration): ToolSpec {
        const caps = [registration.capability, ...(registration.coCapabilities ?? [])];
        let tier: EffectTier = 'auto';
        for (const capability of caps) {
            const effective = this.bind.effective.capabilities[capability];
            if (!effective) continue;
            tier = strictestTier(tier, effective.tier);
        }
        if (registration.trust === 'full') tier = strictestTier(tier, 'gated');
        return {
            name: registration.name,
            description: registration.description,
            parameters: registration.parameters,
            capability: registration.capability,
            effectiveTier: tier === 'forbidden' ? 'gated' : tier,
            trust: registration.trust,
            ...(registration.irreversible ? { irreversible: true } : {}),
        };
    }

    private buildEcho(
        _req: InvocationRequest,
        registration: ToolRegistration,
        projection: ValueProjection,
        invocationId: string,
    ): ApprovalRequest['echo'] {
        const snapshot = this.bind.engine.ledger.snapshot();
        const sources = [
            ...new Set(
                snapshot.entries
                    .filter(
                        (e) =>
                            e.transferDir === 'ingest' &&
                            e.label !== 'public' &&
                            e.label !== 'internal',
                    )
                    .map((e) => e.source),
            ),
        ];
        const targets = this.bind.engine.overlay.targets();
        const label = this.effectiveRule(registration.capability);
        void label;
        return {
            invocationId,
            tool: registration.name,
            effectClass: registration.capability,
            ...(projection.path !== undefined ? { targetAsset: projection.path } : {}),
            ...(projection.host !== undefined ? { counterparty: projection.host } : {}),
            ...(projection.amount !== undefined ? { amount: projection.amount } : {}),
            dataflowSources: sources,
            derivedLabelProvenance: targets,
            generationAttestationText: buildAttestationText(snapshot, targets),
            generationAttestationOptions: ['once', 'generation-attestation', 'reject'],
        };
    }

    private settle(
        decision: ApprovalDecision,
        capability: CapabilityKey,
    ): { code: AuthzErrorCode; hint: string } | undefined {
        if (decision.decision === 'rejected') {
            return { code: 'GATED_REJECTED', hint: decision.reason };
        }
        if (decision.decision === 'cancelled') {
            return { code: 'GATED_REJECTED', hint: '审批取消' };
        }
        if (decision.decision === 'generation-attestation') {
            this.generationAttestation = decision.attestation;
            this.sessionApprovals.push({
                id: ulid(),
                capability,
                scope: 'generation',
                createdAt: this.now(),
            });
            return undefined;
        }
        if (decision.scope !== 'once') {
            this.sessionApprovals.push({
                id: ulid(),
                capability,
                scope: decision.scope,
                createdAt: this.now(),
            });
        }
        return undefined;
    }

    private resolveSecrets(
        registration: ToolRegistration,
        req: InvocationRequest,
    ):
        | { code: AuthzErrorCode; hint: string }
        | { credentials?: Map<string, SignedRequest | CapabilityToken> } {
        const declared = registration.secrets ?? [];
        if (declared.length === 0) return {};
        if (!this.bind.secretResolver || !this.bind.secretRefs) {
            return { code: 'HANDLE_REFUSED', hint: '声明了 secret 但缺少解析器（fail-closed）' };
        }
        const invocation = registration.invocation?.(req.args);
        if (!invocation) {
            return { code: 'HANDLE_REFUSED', hint: '缺少结构化 invocation，无法代签（N16）' };
        }
        const credentials = new Map<string, SignedRequest | CapabilityToken>();
        for (const refId of declared) {
            const ref = this.bind.secretRefs.get(refId);
            if (!ref) return { code: 'HANDLE_REFUSED', hint: `未知句柄：${refId}` };
            const outcome = this.bind.secretResolver.resolve(ref, invocation);
            if (outcome.kind === 'rejected') {
                return { code: outcome.code, hint: outcome.hint };
            }
            if (outcome.kind === 'signed') credentials.set(refId, outcome.signed);
            if (outcome.kind === 'token') credentials.set(refId, outcome.token);
        }
        return { credentials };
    }
}
