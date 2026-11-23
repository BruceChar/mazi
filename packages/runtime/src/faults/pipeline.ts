import {
    DEFAULT_FAULT_POLICY,
    FALLBACK_FAULT_POLICY,
    type Fault,
    type FaultDomainPolicy,
    type FaultPolicy,
    type FaultPolicyTable,
    type FaultRecovery,
    type FaultScope,
} from './types.js';

/**
 * FaultPipeline —— 错误处置层唯一入口。
 *
 * 只做三件事：查策略表、按尝试键计数、产出恢复结论（并广播）。
 * 执行动作由调用方完成（工具调用在 ToolInvoker，模型调用在 provider）。
 */

export type FaultEventType = 'fault.raised' | 'fault.recovered';

export interface FaultPipelineDeps {
    /** 整表替换（测试/实验），缺省用 DEFAULT_FAULT_POLICY。 */
    policy?: FaultPolicyTable;
    /** 按 domain 的覆盖项。 */
    domains?: FaultDomainPolicy;
    /** 广播端口（runtime 接到事件总线）。抛出被吞，不影响主流程。 */
    emit?: (type: FaultEventType, fault: Fault, recovery?: FaultRecovery) => void;
    now?: () => number;
}

export interface FaultPipeline {
    decide(fault: Fault): FaultRecovery;
    /** 调用成功后清零尝试键；返回清零前的次数（>0 说明本次是"恢复成功"）。 */
    reset(key: string): number;
    /** 清零并（此前有失败时）广播 fault.recovered。 */
    recover(key: string, fault?: Fault): number;
    attemptsOf(key: string): number;
}

const MAX_TRACKED_KEYS = 512;

export class DefaultFaultPipeline implements FaultPipeline {
    private readonly attempts = new Map<string, number>();
    private readonly policy: FaultPolicyTable;
    private readonly domains: FaultDomainPolicy;
    private readonly emit:
        | ((type: FaultEventType, fault: Fault, recovery?: FaultRecovery) => void)
        | undefined;

    constructor(deps: FaultPipelineDeps = {}) {
        this.policy = deps.policy ?? DEFAULT_FAULT_POLICY;
        this.domains = deps.domains ?? {};
        this.emit = deps.emit;
    }

    decide(fault: Fault): FaultRecovery {
        const key = fault.key ?? fault.faultId;
        const attempt = (this.attempts.get(key) ?? 0) + 1;
        this.track(key, attempt);
        const policy = this.resolve(fault.domain, fault.kind);
        const recovery = this.recoveryFor(fault, policy, attempt);
        // 观测失败不影响处置结论：广播端口异常在此吞掉。
        try {
            this.emit?.('fault.raised', fault, recovery);
        } catch {
            /* 观测面不可用，主流程继续 */
        }
        return recovery;
    }

    reset(key: string): number {
        const prior = this.attempts.get(key) ?? 0;
        this.attempts.delete(key);
        return prior;
    }

    recover(key: string, fault?: Fault): number {
        const prior = this.reset(key);
        if (prior > 0 && fault !== undefined) {
            try {
                this.emit?.('fault.recovered', fault);
            } catch {
                /* 观测面不可用，主流程继续 */
            }
        }
        return prior;
    }

    attemptsOf(key: string): number {
        return this.attempts.get(key) ?? 0;
    }

    private recoveryFor(fault: Fault, policy: FaultPolicy, attempt: number): FaultRecovery {
        if (fault.severity === 'fatal') {
            return { action: 'abort', attempt, maxRetries: 0, reason: 'fatal' };
        }
        // 非幂等的超时不允许本地重试：重试等于重复副作用。
        if (policy.requiresIdempotent === true && fault.idempotent !== true) {
            return {
                action: policy.onGiveUp,
                attempt,
                maxRetries: policy.maxRetries,
                ...(policy.escalateTo !== undefined ? { escalateTo: policy.escalateTo } : {}),
                reason: 'non-idempotent',
            };
        }
        if (attempt <= policy.maxRetries) {
            return {
                action: 'retry',
                attempt,
                maxRetries: policy.maxRetries,
                ...(policy.backoff === 'exponential'
                    ? { delayMs: (policy.baseDelayMs ?? 100) * 2 ** (attempt - 1) }
                    : {}),
                reason: 'policy',
            };
        }
        return {
            action: policy.onGiveUp,
            attempt,
            maxRetries: policy.maxRetries,
            ...(policy.escalateTo !== undefined ? { escalateTo: policy.escalateTo } : {}),
            reason: 'attempts-exhausted',
        };
    }

    private resolve(domain: string, kind: string): FaultPolicy {
        const base = this.policy[kind] ?? FALLBACK_FAULT_POLICY;
        const override = this.domains[domain]?.[kind];
        if (override === undefined) return base;
        return { ...base, ...override };
    }

    /** 尝试键有界：超过上限时丢弃最早插入的键（只影响计数精度）。 */
    private track(key: string, attempt: number): void {
        if (!this.attempts.has(key) && this.attempts.size >= MAX_TRACKED_KEYS) {
            const oldest = this.attempts.keys().next().value;
            if (oldest !== undefined) this.attempts.delete(oldest);
        }
        this.attempts.set(key, attempt);
    }
}

/** 指数退避的实际等待（调用方执行）。 */
export async function backoffDelay(ms: number | undefined): Promise<void> {
    if (ms === undefined || ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function isEscalation(recovery: FaultRecovery): recovery is FaultRecovery & {
    escalateTo: FaultScope;
} {
    return recovery.action === 'escalate' && recovery.escalateTo !== undefined;
}
