import type { TraceIdentifiers } from './observability.js';

/**
 * Fault 契约 —— 错误处置层（设计见 docs/runtime/AHF_RUNTIME_FAULTS.md）。
 *
 * 分工：生产者只判定失败性质（domain/kind/retryable），错误层（runtime/faults）
 * 决定恢复动作。本文件只放词汇与默认策略表，不含任何执行逻辑。
 */

/** 失败来源域。新增域属于契约变更：同步修订设计文档。 */
export const FAULT_DOMAINS = [
    'provider',
    'tool',
    'hook',
    'verifier',
    'planner',
    'storage',
    'policy',
    'context',
] as const;

export type FaultDomain = (typeof FAULT_DOMAINS)[number];

/** 失败性质闭集（与 provider 错误码不同层：这是跨域的处置分类）。 */
export const FAULT_KINDS = [
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

export type FaultKind = (typeof FAULT_KINDS)[number];

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
    domain: FaultDomain;
    kind: FaultKind;
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

export type FaultPolicyTable = Readonly<Record<FaultKind, FaultPolicy>>;

/** 默认策略表（§5）。domain 覆盖由 runtime 侧按需叠加。 */
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

/** fatal 白名单由 `severity` 判定；本函数只把 kind 映到默认严重度。 */
export function defaultSeverityOf(kind: FaultKind): FaultSeverity {
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

export function isFaultKind(value: string): value is FaultKind {
    return (FAULT_KINDS as readonly string[]).includes(value);
}

export function isFaultDomain(value: string): value is FaultDomain {
    return (FAULT_DOMAINS as readonly string[]).includes(value);
}
