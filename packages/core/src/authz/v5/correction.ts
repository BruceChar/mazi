/**
 * V5 纠正闭环与降档（§10/D8）。
 *
 * 纠正语义：负样本入审计 → 对应指纹删除 → 同模式归零重学并进红区 → 同目标绑定
 * 其他记忆 24h 待审（爆炸半径原则）。模式纠正率超阈值（默认 1%）自动永久弹窗；
 * 降档只收紧、不放开。目标函数是纠正次数，不是弹窗数。
 */

export interface PatternKey {
    action: string;
    objectClass: string;
    targetBinding: string;
}

/** 模式 key = (action, object_class, target_binding)。 */
export function patternKeyOf(pattern: PatternKey): string {
    return [pattern.action, pattern.objectClass, pattern.targetBinding].join('|');
}

export const DEFAULT_CORRECTION_RATE_LIMIT = 0.01;
/** 同目标绑定待审窗口：24h。 */
export const PENDING_BINDING_MS = 24 * 60 * 60 * 1000;

export class CorrectionLog {
    private readonly observations = new Map<string, number>();
    private readonly correctionCounts = new Map<string, number>();
    private readonly frozen = new Set<string>();
    private readonly pendingBindings = new Map<string, number>();
    private rateLimit = DEFAULT_CORRECTION_RATE_LIMIT;

    observe(pattern: PatternKey): void {
        const key = patternKeyOf(pattern);
        this.observations.set(key, (this.observations.get(key) ?? 0) + 1);
    }

    /**
     * 记录一次纠正：模式进红区（归零重学），返回进入待审的目标绑定列表。
     * 指纹删除由调用方在 memory-store 上执行。
     */
    recordCorrection(pattern: PatternKey, binding?: string): string[] {
        const key = patternKeyOf(pattern);
        this.correctionCounts.set(key, (this.correctionCounts.get(key) ?? 0) + 1);
        this.frozen.add(key);
        const pending: string[] = [];
        if (binding !== undefined) {
            this.pendingBindings.set(binding, Date.now() + PENDING_BINDING_MS);
            pending.push(binding);
        }
        return pending;
    }

    corrections(pattern: PatternKey): number {
        return this.correctionCounts.get(patternKeyOf(pattern)) ?? 0;
    }

    correctionRate(pattern: PatternKey): number {
        const key = patternKeyOf(pattern);
        const total = this.observations.get(key) ?? 0;
        if (total === 0) return 0;
        return (this.correctionCounts.get(key) ?? 0) / total;
    }

    /** 红区：纠正过，或纠正率超阈值 → 强制弹窗（永久弹窗直至重新积累零纠正历史）。 */
    isFrozen(pattern: PatternKey): boolean {
        const key = patternKeyOf(pattern);
        return this.frozen.has(key) || this.correctionRate(pattern) > this.rateLimit;
    }

    /** 24h 内确认待审绑定 → 解除；逾期未确认由调用方连带失效。 */
    confirm(binding: string, now: number = Date.now()): boolean {
        const deadline = this.pendingBindings.get(binding);
        if (deadline === undefined) return false;
        if (now > deadline) {
            this.pendingBindings.delete(binding);
            return false;
        }
        this.pendingBindings.delete(binding);
        return true;
    }

    setRateLimit(limit: number): void {
        this.rateLimit = limit;
    }
}
