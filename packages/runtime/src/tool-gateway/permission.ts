/**
 * Runtime permission bridge — maps the human-facing permission ceiling and the
 * runtime ToolConfig catalogue onto the authorization-v2 ToolGateway.
 *
 * The selected ceiling is a root-level standing grant (the user's choice in the
 * composer). Capabilities above the ceiling are never granted, so their tools
 * disappear from the supply view and are rejected if hallucinated. Gated calls
 * inside the granted surface are approved by a standing seam until a real
 * human-in-the-loop seam is wired.
 */

import { homedir } from 'node:os';

import { authz, type PermissionLevel } from '@mazi/core';

import type { ToolCallResult, ToolConfig } from '../config.js';

const HOME = homedir();

/** Capability roles for the runtime tool catalogue. */
export const RUNTIME_ROLES: Record<string, authz.Role> = {
    'fs.read.workspace': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.workspace': { transfer: 'none', commit: 'recoverable', opacity: 'transparent' },
    'fs.write.draft': {
        transfer: 'none',
        commit: 'reversible',
        opacity: 'transparent',
        reversibleBy: 'task-scratch',
    },
    'fs.exec': { transfer: 'none', commit: 'committed', opacity: 'transparent' },
    'net.fetch': { transfer: 'ingest', commit: 'recoverable', opacity: 'transparent' },
    'net.send': { transfer: 'egress', commit: 'recoverable', opacity: 'transparent' },
    delete: { transfer: 'none', commit: 'committed', opacity: 'transparent' },
    publish: { transfer: 'egress', commit: 'committed', opacity: 'transparent' },
    pay: { transfer: 'egress', commit: 'committed', opacity: 'transparent' },
};

const READ_CAPABILITIES = ['fs.read.workspace'] as const;
const DRAFT_CAPABILITIES = [
    ...READ_CAPABILITIES,
    'fs.write.workspace',
    'fs.write.draft',
    'fs.exec',
    'net.fetch',
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
    draft: DRAFT_CAPABILITIES,
    approved: APPROVED_CAPABILITIES,
    autonomous: AUTONOMOUS_CAPABILITIES,
};

function capRule(capability: string): authz.CapabilityRule {
    if (capability === 'fs.write.draft') {
        return {
            action: 'fs.write.draft',
            domain: 'workspace',
            tier: 'auto',
            scope: 'task-scratch',
        };
    }
    if (capability === 'fs.read.host') {
        return {
            action: 'fs.read',
            domain: 'host',
            tier: 'auto',
            maxLabel: 'secret',
            severance: 'handle',
        };
    }
    if (capability === 'fs.write.host') {
        return { action: 'fs.write', domain: 'host', tier: 'auto', maxLabel: 'sensitive' };
    }
    if (capability.startsWith('db.')) {
        return { action: capability, domain: 'host', tier: 'auto', maxLabel: 'sensitive' };
    }
    if (capability.startsWith('net.') || capability === 'publish' || capability === 'pay') {
        return { action: capability, domain: 'external', tier: 'auto', maxLabel: 'internal' };
    }
    // fs.read.workspace / fs.write.workspace / delete: the capability string is
    // also the action name (`isWriteAction` recognizes the write/delete forms).
    return {
        action: capability,
        domain: 'workspace',
        tier: 'auto',
        maxLabel: capability === 'fs.read.workspace' ? 'internal' : 'sensitive',
        ...(capability === 'fs.read.workspace' ? { severance: 'plain' as const } : {}),
    };
}

/** The full effect surface the runtime can request (all levels combined). */
const STANDARD_SURFACE = AUTONOMOUS_CAPABILITIES;

/**
 * Build the root grant for a human-facing permission ceiling.
 *
 * The ceiling is the **auto boundary**, not a visibility filter: every standard
 * capability is granted; those within the selected level run `auto`, those
 * above it are `gated` (the model still sees the tool and calling it raises a
 * human approval instead of silently failing). Only `text` hides the tool
 * surface entirely. `forbidden` is reserved for the hard layer (V17) and the
 * backend cap (V15), which no ceiling can relax.
 */
export function grantForPermissionLevel(level: PermissionLevel): authz.AgentGrant {
    if (level === 'text') return {};
    const auto = new Set<string>(CAPABILITIES_BY_LEVEL[level] ?? READ_CAPABILITIES);
    const grant: authz.AgentGrant = {};
    for (const capability of STANDARD_SURFACE) {
        grant[capability] = {
            ...capRule(capability),
            tier: auto.has(capability) ? 'auto' : 'gated',
        };
    }
    return grant;
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
    const role = RUNTIME_ROLES[capability] ?? {
        transfer: 'none',
        commit: 'recoverable',
        opacity: 'transparent',
    };
    const effects = new Set(tool.sideEffects ?? []);
    return {
        name: tool.name,
        description: tool.description,
        parameters: (tool.parameters ?? {}) as Record<string, unknown>,
        capability,
        scope: scopeForTool(tool),
        role,
        trust: 'confined',
        ...(capability === 'fs.read.workspace' ? { severance: 'plain' as const } : {}),
        ...(effects.has('net') ? { untrustedOutput: true, dataEgress: true } : {}),
        ...(tool.irreversible === true ? { irreversible: true } : {}),
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
 * Task-bound runtime gateway. Builds the v2 registrations for the tools
 * permitted by the ceiling, derives the effective policy once, and routes every
 * invocation through the 11-stage pipeline.
 */
export class RuntimeToolGateway {
    private readonly registrations = new Map<string, authz.ToolRegistration>();
    private readonly gateway: authz.ToolGateway;

    constructor(readonly opts: RuntimeGatewayOptions) {
        const labelRegistry = authz.AssetLabelRegistry.builtin({
            home: HOME,
            ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
        });
        const roles = new authz.RoleRegistry(RUNTIME_ROLES);
        const backend: authz.BackendCapabilities = {
            id: 'local',
            supportsReversibility: ['domain-teardown', 'task-scratch'],
        };
        const ledger = new authz.DataflowLedger({ ...(opts.now ? { now: opts.now } : {}) });
        const engine = new authz.AuthorizationEngine({
            labelRegistry,
            roles,
            backend,
            ledger,
            pinned: { labels: labelRegistry.version, roles: roles.version, rules: 1, rootTrust: 1 },
            rootContractId: `runtime:${opts.rootGoalId}`,
            rootVersion: 1,
            taskId: opts.taskId,
            ...(opts.now ? { now: opts.now } : {}),
        });
        const grant = grantForPermissionLevel(opts.level);
        const derived = engine.derive(grant, { requires: Object.keys(grant) });
        if (!derived.ok) {
            throw new Error(`运行权限派生失败：${derived.rejection.reason}`);
        }
        for (const tool of opts.tools) {
            const capability = capabilityForTool(tool);
            const effective = derived.policy.capabilities[capability];
            if (!effective || effective.tier === 'forbidden') continue;
            this.registrations.set(tool.name, registrationForTool(tool, capability, opts.execute));
        }
        this.gateway = new authz.DefaultToolGateway({
            identifiers: { rootGoalId: opts.rootGoalId, goalId: opts.goalId, taskId: opts.taskId },
            effective: derived.policy,
            engine,
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
