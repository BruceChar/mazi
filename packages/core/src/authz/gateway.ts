/**
 * DefaultToolGateway — the v3 enforcement pipeline (V3 §8).
 *
 * Consumes the immutable EffectivePolicy snapshot from derive() and executes the
 * staged pipeline in order. Every stage emits an audit event; failures are
 * structured (fail-closed). The gateway never computes policy, never resolves a
 * voucher out of args and never widens the snapshot.
 */

import { ulid } from '../ulid.js';
import { type ApprovalTarget, approvalTargetOf } from './command.js';
import {
    type ApprovalDecision,
    type ApprovalRequest,
    type ApprovalScope,
    GATEWAY_PIPELINE_STAGES,
    type GatewayBindInput,
    type GatewayStage,
    type InvocationRequest,
    type InvocationResult,
    type SessionApproval,
    type ToolGateway,
    type ToolRegistration,
    type ToolSpec,
} from './gateway-types.js';
import { matchGlob, normalizeAssetPath } from './glob.js';
import type { ResolvedLabel } from './labels.js';
import { assessQuestions, isWriteCapability } from './risk.js';
import { guardGenericEgress, type SignedRequest } from './secret.js';
import {
    type AuthzErrorCode,
    type Question,
    type SensitivityLabel,
    strictestTier,
    type ValueProjection,
} from './types.js';

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
    const command = firstString(projection.commandParam ? [projection.commandParam] : undefined);
    if (command !== undefined) out.command = command;
    const sql = firstString(projection.sqlParam ? [projection.sqlParam] : undefined);
    if (sql !== undefined) out.sql = sql;
    if (projection.amountParam !== undefined) {
        const raw = args[projection.amountParam];
        if (typeof raw === 'number') out.amount = { currency: 'USD', amount: raw };
        else if (raw && typeof raw === 'object' && 'amount' in raw) {
            out.amount = raw as { currency: string; amount: number };
        }
    }
    return out;
}

/** Every projected value must fall inside the effective rule's declared range. */
export function isInScope(
    projection: ValueProjection,
    spec: { paths?: string[]; hosts?: string[] },
): boolean {
    if (projection.path !== undefined && spec.paths !== undefined) {
        const value = normalizeAssetPath(projection.path);
        if (!spec.paths.some((pattern) => matchGlob(normalizeAssetPath(pattern), value))) {
            return false;
        }
    }
    if (projection.host !== undefined && spec.hosts !== undefined) {
        if (!spec.hosts.some((pattern) => matchGlob(pattern, projection.host as string))) {
            return false;
        }
    }
    return true;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class DefaultToolGateway implements ToolGateway {
    readonly stageNames = GATEWAY_PIPELINE_STAGES;
    private readonly sessionApprovals: SessionApproval[] = [];
    private stepsUsed = 0;
    private readonly now: () => number;

    constructor(private readonly bind: GatewayBindInput) {
        this.now = bind.now ?? (() => Date.now());
    }

    approvals(): readonly SessionApproval[] {
        return this.bind.approvalStore?.list() ?? this.sessionApprovals;
    }

    async invoke(req: InvocationRequest): Promise<InvocationResult> {
        const registration = this.bind.toolRegistry.get(req.tool);
        const stepId = req.stepId ?? ulid();
        const identifiers = {
            ...this.bind.identifiers,
            ...(req.taskId ? { taskId: req.taskId } : {}),
            stepId,
        };
        const log = (
            stage: GatewayStage,
            decision: 'allowed' | 'denied' | 'pending' | 'info',
            extra: {
                capability?: string;
                detail?: string;
                code?: AuthzErrorCode;
                question?: Question;
            } = {},
        ): void => {
            this.bind.audit.log({ stage, decision, identifiers, tool: req.tool, ...extra });
        };
        const reject = (
            code: AuthzErrorCode,
            hint: string,
            stage: GatewayStage,
            extra: { detail?: string; question?: Question } = {},
        ): InvocationResult => {
            log(stage, 'denied', { code, detail: hint, ...extra });
            return {
                kind: 'rejected',
                code,
                hint,
                ...(extra.question ? { question: extra.question } : {}),
            };
        };

        // ① supply-check (closed world)
        if (!registration) {
            return reject('FORBIDDEN_UNREGISTERED', `工具未注册：${req.tool}`, 'supply-check');
        }
        const required = (registration.parameters as { required?: string[] }).required ?? [];
        const missing = required.filter((key) => req.args[key] === undefined);
        if (missing.length > 0) {
            return reject('INVALID_ARGS', `缺少必填参数：${missing.join(', ')}`, 'supply-check');
        }
        log('supply-check', 'allowed');

        // ② scope-check: capability surface + declared range
        const caps: string[] = [registration.capability, ...(registration.coCapabilities ?? [])];
        let needsApproval = false;
        for (const capability of caps) {
            const effective = this.bind.policy.capabilities[capability];
            if (!effective) {
                return reject('FORBIDDEN_BY_POLICY', `能力未授予：${capability}`, 'scope-check');
            }
            if (effective.tier === 'forbidden') {
                return reject('FORBIDDEN_BY_POLICY', `能力被禁止：${capability}`, 'scope-check');
            }
            if (effective.tier === 'gated') needsApproval = true;
        }
        const primary = this.bind.policy.capabilities[registration.capability];
        if (!primary) {
            return reject(
                'FORBIDDEN_BY_POLICY',
                `能力未授予：${registration.capability}`,
                'scope-check',
            );
        }
        const projection = projectValues(req.args, registration.scope);
        if (!isInScope(projection, primary.spec)) {
            return reject('FORBIDDEN_BY_POLICY', '调用参数超出授权范围', 'scope-check');
        }
        const target: ResolvedLabel =
            projection.path !== undefined
                ? this.bind.labels.resolve({ kind: 'path', value: projection.path })
                : {
                      label: primary.targetLabel,
                      boundary: primary.boundary,
                      specificity: 0,
                      matches: [],
                  };
        log('scope-check', 'allowed');

        // ③ risk-check: three questions + hard floor
        const assessment = assessQuestions({
            capability: registration.capability,
            semantics: registration.semantics,
            projection,
            target,
        });
        if (assessment.hard === 'forbidden') {
            return reject(
                'FORBIDDEN_BY_HARD_FLOOR',
                assessment.hardReason ?? '底线钳制',
                'risk-check',
                {
                    question: 'Q3',
                },
            );
        }
        if (
            registration.semantics.ingest === true &&
            target.label === 'secret' &&
            registration.semantics.severance !== true
        ) {
            return reject(
                'FORBIDDEN_BY_HARD_FLOOR',
                '秘密级读必须断流，但该工具未声明断流能力',
                'risk-check',
                { question: 'Q2' },
            );
        }
        let tier = primary.tier;
        for (const capability of caps) {
            const effective = this.bind.policy.capabilities[capability];
            if (effective) tier = strictestTier(tier, effective.tier);
        }
        tier = strictestTier(tier, assessment.floor);
        if (registration.trust === 'full') tier = strictestTier(tier, 'gated');
        if (tier === 'gated') needsApproval = true;
        const questionDetail = assessment.questions.map((q) => q.question).join(',') || 'none';
        log('risk-check', 'info', { detail: `tier=${tier} questions=${questionDetail}` });

        // ④ ledger-adjudication (egress): voucher opacity + outbound ledger check
        let egressVersion = -1;
        let egressWasBroken = false;
        const egressing =
            registration.semantics.egress === true || registration.semantics.dataEgress === true;
        if (egressing) {
            const guarded = guardGenericEgress(req.args, {
                mode: 'reject',
                audit: {
                    log: (event) =>
                        log('ledger-adjudication', 'info', { detail: JSON.stringify(event) }),
                },
            });
            if (guarded.kind === 'rejected') {
                return reject(
                    guarded.code ?? 'HANDLE_REFUSED',
                    guarded.hint ?? '出站含句柄',
                    'ledger-adjudication',
                );
            }
            const verdict = this.bind.ledger.adjudicate();
            egressVersion = verdict.version;
            egressWasBroken = verdict.broken;
            if (verdict.broken) needsApproval = true;
            log('ledger-adjudication', verdict.broken ? 'info' : 'allowed', {
                detail: verdict.broken
                    ? `ledger-sensitive:${verdict.sources.join(',')}`
                    : 'ledger-clean',
            });
        } else {
            log('ledger-adjudication', 'allowed', { detail: 'not-egress' });
        }

        // ⑤ approval (fail-closed when absent)
        const approval = approvalTargetOf(registration, projection);
        const approvalHit = !approval.alwaysPrompt && this.hasApproval(approval.key);
        if (needsApproval && !approvalHit) {
            if (!this.bind.approval) {
                return reject(
                    'APPROVAL_UNAVAILABLE',
                    '无审批 seam：gated 调用 fail-closed',
                    'approval',
                );
            }
            const invocationId = ulid();
            const request: ApprovalRequest = {
                invocationId,
                tool: req.tool,
                capability: registration.capability,
                echo: this.buildEcho(registration, projection, invocationId),
                allowedScopes: approval.allowedScopes,
                identifiers,
            };
            log('approval', 'pending', { detail: 'approval-requested' });
            const decision = await this.bind.approval.decide(request);
            const settled = this.settle(decision, approval, registration.capability);
            if (settled) return reject(settled.code, settled.hint, 'approval');
            log('approval', 'allowed', { detail: decision.decision });
        } else {
            log('approval', 'allowed', {
                detail: needsApproval ? 'approval-hit' : 'not-required',
            });
        }

        // INV-B: a commit between adjudication and execution forces re-adjudication
        if (egressing && egressVersion >= 0 && this.bind.ledger.recheck(egressVersion)) {
            const recheck = this.bind.ledger.adjudicate();
            if (recheck.broken && !egressWasBroken) {
                return reject(
                    'EGRESS_BLOCKED',
                    '账本在裁决后新增敏感读：重新裁决为破缺，fail-closed',
                    'ledger-adjudication',
                );
            }
        }

        // ⑥ budget
        this.stepsUsed += 1;
        const stepLimit = this.bind.budget?.steps;
        if (stepLimit !== undefined && this.stepsUsed > stepLimit) {
            return reject('BUDGET_EXHAUSTED', `步数预算耗尽（${stepLimit}）`, 'execute');
        }

        // ⑦ execute (+ gateway signer; handler never touches the wire format)
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
            log('execute', 'denied', { detail: errorMessage(error) });
            return { kind: 'failed', error: errorMessage(error), code: 'EXECUTION_FAILED' };
        }
        log('execute', 'allowed');

        // ⑧ writeback: sever a secret read, commit the read (INV-A), apply residue taint
        const untrusted = registration.untrustedOutput === true || output.untrusted === true;
        const severedRead =
            registration.semantics.ingest === true &&
            registration.semantics.severance === true &&
            target.label === 'secret';
        let value = output.value;
        if (severedRead) {
            if (!this.bind.secretService) {
                return reject(
                    'HANDLE_REFUSED',
                    '秘密级读需要断流但缺少 SecretService（fail-closed）',
                    'writeback',
                );
            }
            const severed = this.bind.secretService.sever({
                refId: `${registration.name}:${stepId}`,
                allowedSinks: [registration.name],
                purpose: registration.secretPurpose ?? {
                    service: registration.name,
                    actions: ['read'],
                    resourcePattern: '*',
                },
                value: typeof value === 'string' ? value : String(value ?? ''),
                profile: this.bind.secretService.profileFor(projection.path ?? ''),
            });
            value = { handle: severed.handle, attributes: severed.attributes };
        }
        if (registration.semantics.ingest === true) {
            this.bind.ledger.commit({
                label: target.label as SensitivityLabel,
                source: registration.capability,
                stepId,
                severed: severedRead,
            });
        }
        if (isWriteCapability(registration.capability) && projection.path !== undefined) {
            this.bind.taint.markFromLedger(projection.path, this.bind.ledger);
        }
        log('writeback', 'allowed', { detail: untrusted ? 'untrusted' : 'committed' });

        // ⑨ audit
        log('audit', 'allowed', { detail: 'executed' });
        return untrusted
            ? { kind: 'executed', value, untrusted: true }
            : { kind: 'executed', value };
    }

    private hasApproval(key: string): boolean {
        if (this.bind.approvalStore?.has(key, this.bind.sessionId) === true) return true;
        return this.sessionApprovals.some((approval) => approval.key === key);
    }

    toolSpec(registration: ToolRegistration): ToolSpec {
        const caps = [registration.capability, ...(registration.coCapabilities ?? [])];
        let tier = registration.trust === 'full' ? strictestTier('gated') : ('auto' as const);
        for (const capability of caps) {
            const effective = this.bind.policy.capabilities[capability];
            if (effective) tier = strictestTier(tier, effective.tier);
        }
        return {
            name: registration.name,
            description: registration.description,
            parameters: registration.parameters,
            capability: registration.capability,
            effectiveTier: tier === 'forbidden' ? 'gated' : tier,
            trust: registration.trust,
            ...(registration.semantics.irreversible ? { irreversible: true } : {}),
        };
    }

    private buildEcho(
        registration: ToolRegistration,
        projection: ValueProjection,
        invocationId: string,
    ): ApprovalRequest['echo'] {
        const verdict = this.bind.ledger.adjudicate();
        return {
            invocationId,
            tool: registration.name,
            effectClass: registration.capability,
            ...(projection.command !== undefined ? { command: projection.command } : {}),
            ...(projection.path !== undefined ? { targetAsset: projection.path } : {}),
            ...(projection.host !== undefined ? { counterparty: projection.host } : {}),
            ...(projection.amount !== undefined ? { amount: projection.amount } : {}),
            dataflowSources: verdict.sources,
            taintProvenance: this.bind.taint.targets(),
        };
    }

    private settle(
        decision: ApprovalDecision,
        target: ApprovalTarget,
        capability: string,
    ): { code: AuthzErrorCode; hint: string } | undefined {
        if (decision.decision === 'rejected') {
            return { code: 'GATED_REJECTED', hint: decision.reason };
        }
        if (decision.decision === 'cancelled') {
            return { code: 'GATED_REJECTED', hint: '审批取消' };
        }
        // 高危命令永远逐次：忽略 UI 传来的 session/workspace，不落任何预授权。
        const scope: ApprovalScope = target.alwaysPrompt ? 'once' : decision.scope;
        if (scope !== 'once') {
            const approval: SessionApproval = {
                id: ulid(),
                key: target.key,
                capability,
                scope,
                ...(this.bind.sessionId !== undefined ? { sessionId: this.bind.sessionId } : {}),
                createdAt: this.now(),
            };
            // 无会话 id 的 session 授权退化为本次 run 内有效（网关实例内），
            // 不上浮到进程级 store，避免误命中其它会话。
            if (
                this.bind.approvalStore &&
                !(scope === 'session' && this.bind.sessionId === undefined)
            ) {
                this.bind.approvalStore.remember(approval);
            } else {
                this.sessionApprovals.push(approval);
            }
        }
        return undefined;
    }

    private resolveSecrets(
        registration: ToolRegistration,
        req: InvocationRequest,
    ): { code: AuthzErrorCode; hint: string } | { credentials?: Map<string, SignedRequest> } {
        const declared = registration.secrets ?? [];
        if (declared.length === 0) return {};
        if (!this.bind.secretService) {
            return { code: 'HANDLE_REFUSED', hint: '声明了 secret 但缺少解析器（fail-closed）' };
        }
        const invocation = registration.invocation?.(req.args);
        if (!invocation) {
            return { code: 'HANDLE_REFUSED', hint: '缺少结构化 invocation，无法代签' };
        }
        const credentials = new Map<string, SignedRequest>();
        for (const refId of declared) {
            const outcome = this.bind.secretService.resolve(refId, registration.name, invocation);
            if (outcome.kind === 'rejected') {
                return { code: outcome.code, hint: outcome.hint };
            }
            credentials.set(refId, outcome.signed);
        }
        return { credentials };
    }
}
