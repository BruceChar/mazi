import type { TraceIdentifiers } from '@mazi/core';

/**
 * Fault 契约 —— 运行时业务层（设计见 docs/runtime/AHF_RUNTIME_FAULTS.md §3）。
 *
 * 刻意**不**放进 core：`domain` / `kind` 是开放字符串，由各业务域自己声明常量。
 * 新增 planner / verifier / 任何后续角色只在自己的模块里加值，不触发 core 变更。
 */

/** 严重度由生产者给出，错误层不得提升或降低。 */
export type FaultSeverity = 'recoverable' | 'degradable' | 'fatal';

/** 处置作用域：错误在能吸收它的最小作用域处理，向上只升级一次。 */
export const FAULT_SCOPES = ['call', 'turn', 'task', 'goal', 'session'] as const;

export type FaultScope = (typeof FAULT_SCOPES)[number];

/** 恢复动作（§4 恢复阶梯）。 */
export type FaultAction = 'retry' | 'retry_altered' | 'fallback' | 'degrade' | 'escalate' | 'abort';

/** 参数类失败的结构化修正提示（回给模型，不自动重试）。 */
export interface FaultFix {
    missing?: string[];
    expected?: string;
    got?: string;
}

export interface Fault {
    faultId: string;
    /** 产出方声明的域（如 'provider' / 'tool' / 未来任意业务域）。 */
    domain: string;
    /** 处置分类；内置默认见 BUILTIN_FAULT_KINDS，未登记的新值走兜底策略。 */
    kind: string;
    severity: FaultSeverity;
    scope: FaultScope;
    /** 生产者的判断；与策略表冲突时以策略表为准（冲突记一条事件）。 */
    retryable: boolean;
    /** 决定"超时能否重试"的前提；未声明视为非幂等。 */
    idempotent?: boolean;
    /** 尝试计数键：同参调用必须一致，跨轮次共享。 */
    key?: string;
    /** 厂商/网关原始码，保留可追溯。 */
    code?: string;
    message: string;
    hint?: string;
    fix?: FaultFix;
    identifiers?: TraceIdentifiers;
    cause?: unknown;
}

/** 策略条目：本地重试预算用尽后走 `onGiveUp`。 */
export interface FaultPolicy {
    /** 同参自动重试次数上限（0 = 不自动重试）。 */
    maxRetries: number;
    backoff: 'none' | 'exponential';
    /** 指数退避基数（毫秒）。 */
    baseDelayMs?: number;
    /** 仅幂等故障可重试（超时类）。 */
    requiresIdempotent?: boolean;
    onGiveUp: FaultAction;
    /** `onGiveUp === 'escalate'` 时的目标作用域。 */
    escalateTo?: FaultScope;
}

export type FaultPolicyTable = Readonly<Record<string, FaultPolicy>>;

/**
 * 内置默认策略键（**不是闭集**，只是 runtime 自带的一组处置基线）。
 * 各域可以自由引入新 kind；表里没登记的 kind 落 `FALLBACK_FAULT_POLICY`。
 */
export const BUILTIN_FAULT_KINDS = [
    'timeout',
    'transient',
    'invalid_args',
    'not_found',
    'policy_denied',
    'internal',
    'budget_exhausted',
    'fatal',
    'unknown',
] as const;

/** 默认策略表（§5）。domain 覆盖由调用方按需叠加。 */
export const DEFAULT_FAULT_POLICY: FaultPolicyTable = {
    timeout: {
        maxRetries: 1,
        backoff: 'none',
        requiresIdempotent: true,
        onGiveUp: 'degrade',
    },
    transient: {
        maxRetries: 2,
        backoff: 'exponential',
        baseDelayMs: 100,
        onGiveUp: 'escalate',
        escalateTo: 'turn',
    },
    invalid_args: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'retry_altered',
    },
    not_found: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'retry_altered',
    },
    policy_denied: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'abort',
    },
    internal: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'degrade',
    },
    budget_exhausted: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'abort',
    },
    fatal: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'abort',
    },
    unknown: {
        maxRetries: 0,
        backoff: 'none',
        onGiveUp: 'degrade',
    },
};

/** 未登记 kind 的兜底：保守降级，绝不放大重试。 */
export const FALLBACK_FAULT_POLICY: FaultPolicy = {
    maxRetries: 0,
    backoff: 'none',
    onGiveUp: 'degrade',
};

/** 单次处置结论（错误层产出，调用方执行）。 */
export interface FaultRecovery {
    action: FaultAction;
    /** 第几次尝试（含本次）。 */
    attempt: number;
    maxRetries: number;
    /** `retry` 时的等待毫秒数。 */
    delayMs?: number;
    escalateTo?: FaultScope;
    reason: 'policy' | 'attempts-exhausted' | 'fatal' | 'non-idempotent';
}

/** kind → 默认严重度；未登记的 kind 按"可降级"处理（保守但不中止）。 */
export function defaultSeverityOf(kind: string): FaultSeverity {
    switch (kind) {
        case 'fatal':
            return 'fatal';
        case 'timeout':
        case 'transient':
            return 'recoverable';
        default:
            return 'degradable';
    }
}

/** 域覆盖表：`{ [domain]: { [kind]: 覆盖项 } }`，两维都开放。 */
export type FaultDomainPolicy = {
    [domain: string]: Record<string, Partial<FaultPolicy>> | undefined;
};
