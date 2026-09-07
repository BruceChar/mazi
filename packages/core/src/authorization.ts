/**
 * Authorization 契约 —— 权限系统的全部数据模型。
 *
 * 权限三段生命：grant(根层签署) → derive(派生计算) → enforce(Capacity 强制执行)。
 * 本文件定义前两段的类型；第三段的行为契约见 capacity.ts。
 */

// —— 权限原子 ——
export type EffectClass =
    | 'fs.read.workspace'
    | 'fs.read.host'
    | 'fs.write.draft'
    | 'fs.write.sandbox'
    | 'fs.write.workspace'
    | 'fs.exec'
    | 'net.fetch'
    | 'net.send'
    | 'db.read'
    | 'db.write'
    | 'db.schema'
    | 'publish'
    | 'pay'
    | 'delete'
    | `external.${string}`
    | (string & {});

export type EffectTier = 'auto' | 'gated' | 'forbidden' | (string & {});
export type Trigger = 'on-failure' | 'on-request' | (string & {});

// —— 规则与授权 ——
export interface EffectRule {
    tier: EffectTier;
    trigger?: Trigger;
    paths?: string[];
    hosts?: string[];
    amountLimit?: { currency: string; amount: number };
}

export interface Budget {
    maxSteps?: number;
    maxTokens?: number;
    maxCostUsd?: number;
}

export type AgentGrant = Partial<Record<EffectClass, EffectRule>> & {
    rootContractId: string;
    version: number;
    budget?: Budget;
};

export interface TaskPolicyRequest {
    requires: EffectClass[];
    wants?: Partial<Record<EffectClass, EffectRule>>;
}

export interface EffectivePolicy {
    rules: Partial<Record<EffectClass, EffectRule>>;
    derivedFrom: { rootContractId: string; rootVersion: number; turnId: string };
}

export type DeriveResult =
    | { ok: true; policy: EffectivePolicy }
    | { ok: false; revision: { wants: EffectClass }; reason: string };

// —— V8 规范常量：恒 gated 类，白名单不豁免 ——
export const ALWAYS_GATED_CLASSES: readonly EffectClass[] = [
    'delete',
    'db.schema',
    'pay',
    'publish',
] as const;

// —— DangerRule 契约（V16：不参与 meet，任何层不可放宽）——
export interface DangerRule {
    id: string;
    match: {
        commandPatterns?: RegExp[];
        sqlPredicates?: string[];
        pathGlobs?: string[];
        effectClasses?: EffectClass[];
    };
    outcome: 'forbidden' | 'always-gated';
    reason: string;
}

export interface AppliedDangerRule {
    ruleId: string;
    outcome: 'forbidden' | 'always-gated';
    reason: string;
    appliesTo: EffectClass[];
}

// —— 危险组合守卫（Guard 的唯一合法用法之一）——
export interface GuardRule {
    id: string;
    when: (p: EffectivePolicy) => boolean;
    downgrade: Partial<Record<EffectClass, EffectTier>>;
    reason: string;
}

// —— 拒绝码（结构化，防死循环）——
export type RejectCode =
    | 'FORBIDDEN_UNREGISTERED'
    | 'FORBIDDEN_BY_POLICY'
    | 'FORBIDDEN_BY_DANGER_RULE'
    | 'GATED_PENDING'
    | 'GATED_REJECTED'
    | 'BUDGET_EXHAUSTED'
    | 'SANDBOX_UNAVAILABLE'
    | 'APPROVAL_UNAVAILABLE'
    | (string & {});
