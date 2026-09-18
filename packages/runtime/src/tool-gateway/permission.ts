/**
 * Runtime permission bridge — maps the human-facing permission ceiling and the
 * runtime ToolConfig catalogue onto the authorization-v3 execution gateway.
 *
 * The selected ceiling is the **auto boundary**, not a visibility filter: every
 * standard capability is granted, those within the selected level run `auto`,
 * those above it are `gated` (the model still sees the tool and calling it
 * raises a human approval instead of silently failing). Only `text` hides the
 * tool surface entirely. `forbidden` is reserved for the hard floor, which no
 * ceiling can relax. Q1/Q3 floors always force at least `gated`.
 */

import { homedir } from 'node:os';

import { authz, type PermissionLevel } from '@mazi/core';

import type { ToolCallResult, ToolConfig } from '../config.js';

const HOME = homedir();

/** Three-question semantic declaration per runtime capability. */
export const RUNTIME_SEMANTICS: Record<string, authz.ToolSemantics> = {
    'fs.read.workspace': { ingest: true },
    'fs.write.workspace': {},
    'fs.write.draft': {},
    'fs.exec': {},
    'net.fetch': { ingest: true },
    'net.send': { egress: true, dataEgress: true },
    delete: { irreversible: true },
    publish: { irreversible: true, egress: true, dataEgress: true },
    pay: { irreversible: true, egress: true, dataEgress: true },
    'fs.read.host': { ingest: true, severance: true },
    'fs.write.host': {},
    'db.read': { ingest: true },
    'db.write': {},
    'db.schema': { irreversible: true },
};

const READ_CAPABILITIES = ['fs.read.workspace'] as const;
const DRAFT_CAPABILITIES = [
    ...READ_CAPABILITIES,
    'fs.write.workspace',
    'fs.write.draft',
    'fs.exec',
    'net.fetch',
] as const;
const WORKSPACE_WRITE_CAPABILITIES = [
    ...READ_CAPABILITIES,
    'fs.write.workspace',
    'fs.write.draft',
] as const;
const APPROVED_CAPABILITIES = [
    ...DRAFT_CAPABILITIES,
    'net.send',
    'delete',
    'publish',
    'pay',
] as const;
const AUTONOMOUS_CAPABILITIES = [
    ...APPROVED_CAPABILITIES,
    'fs.read.host',
    'fs.write.host',
    'db.read',
    'db.write',
    'db.schema',
] as const;

const CAPABILITIES_BY_LEVEL: Record<string, readonly string[]> = {
    text: [],
    'read-only': READ_CAPABILITIES,
    'workspace-write': WORKSPACE_WRITE_CAPABILITIES,
    draft: DRAFT_CAPABILITIES,
    approved: APPROVED_CAPABILITIES,
    autonomous: AUTONOMOUS_CAPABILITIES,
};

function capSpec(capability: string, tier: authz.EffectTier): authz.CapabilitySpec {
    if (capability === 'fs.read.host') return { tier, maxLabel: 'secret' };
    if (capability === 'fs.write.host') return { tier, maxLabel: 'sensitive' };
    if (capability.startsWith('db.')) return { tier, maxLabel: 'sensitive' };
    if (capability.startsWith('net.') || capability === 'publish' || capability === 'pay') {
        return { tier, maxLabel: 'internal' };
    }
    return {
        tier,
        maxLabel: capability === 'fs.read.workspace' ? 'internal' : 'sensitive',
    };
}

/** The full effect surface the runtime can request (all levels combined). */
const STANDARD_SURFACE = AUTONOMOUS_CAPABILITIES;

/** Build the root grant for a human-facing permission ceiling. */
export function grantForPermissionLevel(level: PermissionLevel): authz.Grant {
    if (level === 'text') return { caps: {} };
    const auto = new Set<string>(CAPABILITIES_BY_LEVEL[level] ?? READ_CAPABILITIES);
    const caps: Record<string, authz.CapabilitySpec> = {};
    for (const capability of STANDARD_SURFACE) {
        caps[capability] = capSpec(capability, auto.has(capability) ? 'auto' : 'gated');
    }
    return { caps };
}

/** Dispatch capability for a runtime tool. */
export function capabilityForTool(tool: ToolConfig): string {
    if (tool.name === 'shell.run') return 'fs.exec';
    const effects = new Set(tool.sideEffects ?? []);
    if (effects.has('net')) return tool.irreversible === true ? 'net.send' : 'net.fetch';
    if (effects.has('fs')) return 'fs.write.workspace';
    return 'fs.read.workspace';
}

function scopeForTool(tool: ToolConfig): authz.ScopeProjection {
    if (tool.name === 'shell.run') return { commandParam: 'command' };
    const effects = new Set(tool.sideEffects ?? []);
    if (effects.has('net')) return { hostParams: ['url'] };
    const properties = (tool.parameters as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
    if (properties?.path) return { pathParams: ['path'] };
    if (properties?.a && properties?.b) return { pathParams: ['a', 'b'] };
    return {};
}

function registrationForTool(
    tool: ToolConfig,
    capability: string,
    execute: RuntimeGatewayOptions['execute'],
): authz.ToolRegistration {
    const effects = new Set(tool.sideEffects ?? []);
    return {
        name: tool.name,
        description: tool.description,
        parameters: (tool.parameters ?? {}) as Record<string, unknown>,
        capability,
        semantics: RUNTIME_SEMANTICS[capability] ?? {},
        scope: scopeForTool(tool),
        trust: 'confined',
        ...(effects.has('net') ? { untrustedOutput: true } : {}),
        handler: async (args) => {
            const result = await execute(tool, args);
            if (!result.ok) throw new Error(result.error ?? `工具执行失败：${tool.name}`);
            return { value: result.content ?? '' };
        },
    };
}

/** Standing approval: the ceiling selection is the user's consent for gated calls. */
export function standingApprovalSeam(): authz.ApprovalSeam {
    return {
        decide: async () => ({ decision: 'granted', scope: 'session' }),
    };
}

export interface RuntimeGatewayOptions {
    rootGoalId: string;
    goalId: string;
    taskId: string;
    level: PermissionLevel;
    tools: readonly ToolConfig[];
    execute: (tool: ToolConfig, args: Record<string, unknown>) => Promise<ToolCallResult>;
    audit?: authz.GatewayAuditSink;
    approval?: authz.ApprovalSeam;
    workspaceRoot?: string;
    now?: () => number;
}

/**
 * Task-bound runtime gateway. Builds the v3 registrations for the tools
 * permitted by the ceiling, derives the effective policy once, and routes every
 * invocation through the staged pipeline.
 */
export class RuntimeToolGateway {
    private readonly registrations = new Map<string, authz.ToolRegistration>();
    private readonly gateway: authz.DefaultToolGateway;

    constructor(readonly opts: RuntimeGatewayOptions) {
        const labels = authz.AssetLabelRegistry.builtin({
            home: HOME,
            ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
        });
        const ledger = new authz.DataflowLedger();
        const taint = new authz.TaintTable({ home: HOME });
        const grant = grantForPermissionLevel(opts.level);
        const derived = authz.derive(
            grant,
            { requires: Object.keys(grant.caps) },
            {
                labels,
                semantics: RUNTIME_SEMANTICS,
                pinned: { labels: labels.version, rules: 1, trust: 1 },
                rootId: `runtime:${opts.rootGoalId}`,
                rootVersion: 1,
                taskId: opts.taskId,
            },
        );
        if (!derived.ok) {
            throw new Error(`运行权限派生失败：${derived.rejection.hint}`);
        }
        for (const tool of opts.tools) {
            const capability = capabilityForTool(tool);
            const effective = derived.policy.capabilities[capability];
            if (!effective || effective.tier === 'forbidden') continue;
            this.registrations.set(tool.name, registrationForTool(tool, capability, opts.execute));
        }
        this.gateway = new authz.DefaultToolGateway({
            identifiers: { rootGoalId: opts.rootGoalId, goalId: opts.goalId, taskId: opts.taskId },
            policy: derived.policy,
            labels,
            ledger,
            taint,
            toolRegistry: this.registrations,
            approval: opts.approval ?? standingApprovalSeam(),
            audit: opts.audit ?? { log: () => {} },
            ...(opts.now ? { now: opts.now } : {}),
        });
    }

    /** Supply view: only tools permitted by the ceiling are advertised. */
    visibleToolNames(): string[] {
        return [...this.registrations.keys()];
    }

    async invoke(
        toolName: string,
        args: Record<string, unknown>,
        ctx: { stepId?: string } = {},
    ): Promise<ToolCallResult> {
        if (!this.registrations.has(toolName)) {
            return { ok: false, error: `工具被策略拦截：${toolName}` };
        }
        const result = await this.gateway.invoke({
            tool: toolName,
            args,
            ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
        });
        switch (result.kind) {
            case 'executed':
                return { ok: true, content: result.value };
            case 'failed':
                return { ok: false, error: result.error };
            case 'rejected':
                return { ok: false, error: `${result.code}: ${result.hint}` };
            case 'pending':
                return { ok: false, error: result.hint };
        }
    }
}
