/**
 * V5 学习层 routine（§9/D7）。
 *
 * 学习只碰目标轴：target_trust / conventions / sensitivity / correction_log，
 * 只存元数据（路径、目标、命令形态、事件），不读不存文件内容。routine 门槛：
 * 模式见过 + 观测 ≥5 + 零纠正 + 低方差 + q1∈{reversible,compensable} + 非 hazard；
 * 新颖一律弹窗。污点会话批准事件不进模型（输入隔离）。
 */

import { type PatternKey, patternKeyOf } from './correction.js';
import type { Q1 } from './decision.js';

export const MIN_OBSERVATIONS = 5;

export interface RoutinePatternInput extends PatternKey {
    q1: Q1;
    variance?: 'low' | 'high';
    /** 污点会话批准事件 → 输入隔离，不进模型。 */
    taintedSource?: boolean;
}

interface StoredPattern {
    observations: number;
    corrections: number;
    q1: Q1;
    variance: 'low' | 'high';
}

export class RoutineModel {
    private readonly patterns = new Map<string, StoredPattern>();

    observe(input: RoutinePatternInput): void {
        if (input.taintedSource) return;
        const key = patternKeyOf(input);
        const existing = this.patterns.get(key);
        if (existing) {
            existing.observations++;
            return;
        }
        this.patterns.set(key, {
            observations: 1,
            corrections: 0,
            q1: input.q1,
            variance: input.variance ?? 'low',
        });
    }

    /** 纠正：计数 + 归零重学（红区由 CorrectionLog 管理）。 */
    recordCorrection(pattern: PatternKey): void {
        const cur = this.patterns.get(patternKeyOf(pattern));
        if (!cur) return;
        cur.corrections++;
        cur.observations = 0;
    }

    isRoutine(input: RoutinePatternInput, opts: { hazard: boolean }): boolean {
        if (opts.hazard) return false;
        if (input.q1 === 'irreversible' || input.q1 === 'unproven') return false;
        const cur = this.patterns.get(patternKeyOf(input));
        if (!cur) return false;
        if (cur.corrections > 0) return false;
        if (cur.observations < MIN_OBSERVATIONS) return false;
        if (cur.variance !== 'low') return false;
        return true;
    }
}
