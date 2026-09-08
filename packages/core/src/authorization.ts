/**
 * Authorization 契约 —— 权限系统的全部数据模型。
 *
 * 权限三段生命：grant(根层签署) → derive(派生计算) → enforce(调用时强制)。
 * 本文件定义前两段的类型；第三段的行为契约见 tool-gateway.ts（ToolGateway）。
 *
 * ── 枚举开放扩展约定 ─────────────────────────────────────────────────
 * EffectClass / EffectTier / Trigger / PermissionLevel / SideEffectScope /
 * RejectCode 均以 `(string & {})` 收尾——保留字面量自动补全与判别力的
 * 同时允许平台扩展。各类扩展语义：
 *   - EffectClass      新工具注册新效果类别；未注册类别 closed-world
 *                      兜底 forbidden（V5），扩展无安全风险
 *   - EffectTier       平台自定义档位须给出与标准三档的偏序映射，
 *                      否则派生取严逻辑（meet）无法比较
 *   - Trigger          平台自定义升权触发时机
 *   - PermissionLevel  扩展档位无法从标准 PRESETS 构造，须由平台提供
 *                      具名 grant 工厂（见类型注释的定位警示）
 *   - SideEffectScope  纯描述性元数据，扩展无约束
 *   - RejectCode       平台自定义拒绝码仍须遵守"结构化 + 可行动 hint"
 *                      契约（防重试死循环）
 */

// ============================================================
// §1 权限原子
// ============================================================

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

/**
 * v2 五级语义档位。
 *
 * ── 定位警示 ─────────────────────────────────────────────────────────
 * PermissionLevel 是 AgentGrant 预设工厂（PRESETS）的索引，不是权限本体。
 * 实际权限治理由 EffectivePolicy 承担。它仅用于：
 *   ① 根层以人类可读档位签发 grant（makeRootGrant(level, ...)）
 *   ② 观测/审计/路由的粗粒度展示（inferPermissionLevel 从 effective
 *      反推的产物，tool-gateway 消费）
 * 任何 enforce 判定不得读 PermissionLevel，只读 EffectivePolicy——
 * 档位是索引，规则是本体。
 * 扩展档位（非标准五档）无法从 PRESETS 构造，须由平台提供具名
 * grant 工厂并在组合根注册。
 */
export type PermissionLevel =
    | 'text' // 仅生成文本，无任何效果
    | 'read-only' // 可读不可写
    | 'draft' // 写入暂存区
    | 'approved' // 经审批可对外
    | 'autonomous' // 受限自主
    | (string & {});

/**
 * 副作用域 —— 工具注册时的粗分类标注。
 *
 * ── 定位警示 ─────────────────────────────────────────────────────────
 * 纯描述性元数据：用于观测聚合、审计分类、工具目录检索。
 * 不参与派单与 enforce 判定——权限判定只认 EffectClass，任何实现
 * 拿 SideEffectScope 做权限判断都是缺陷。
 * 与 EffectClass 有映射但不等价：
 *   fs.* → 'fs'；net.* → 'net'；fs.exec → 'process'；
 *   db.* → 'db'；pay → 'pay'；external.* → 'external-api'
 */
export type SideEffectScope =
    | 'fs'
    | 'net'
    | 'process'
    | 'db'
    | 'pay'
    | 'external-api'
    | (string & {});

// ============================================================
// §2 规则与授权
// ============================================================

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
    timeoutMs?: number;
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

// ============================================================
// §3 规范常量
// ============================================================

// —— V8 规范常量：恒 gated 类，白名单不豁免 ——
export const ALWAYS_GATED_CLASSES: readonly EffectClass[] = [
    'delete',
    'db.schema',
    'pay',
    'publish',
] as const;

// ============================================================
// §4 DangerRule（V16：不参与 meet，任何层不可放宽）
// ============================================================

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

// ============================================================
// §5 危险组合守卫（Guard 的唯一合法用法之一）
// ============================================================

export interface GuardRule {
    id: string;
    when: (p: EffectivePolicy) => boolean;
    downgrade: Partial<Record<EffectClass, EffectTier>>;
    reason: string;
}

// ============================================================
// §6 拒绝码（结构化，防死循环）
// ============================================================

/**
 * 裸 permission denied 是 agent 重试死循环的头号来源——拒绝必须
 * 结构化且可行动。平台扩展码仍须遵守此契约并给出可行动 hint。
 */
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
