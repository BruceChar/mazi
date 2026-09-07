import type { FeatureFlagDefinition, FlagRule, FlagSnapshot } from '@mazi/core';

/** Flag 求值上下文：Session 级上下文（Turn 级 flag 由调用方传 turnTags） */
export interface FlagContext {
    sessionId: string;
    userId?: string;
    /** 匹配 GoalContract.strategyHints */
    goalTags?: string[];
    /** 匹配 TurnContract.tags（Turn 级 flag 用） */
    turnTags?: string[];
}

/** sessionId 稳定哈希分桶 0-99（FNV-1a，32bit），供 A/B 规则匹配 */
export function hashToBucket(sessionId: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < sessionId.length; i++) {
        hash ^= sessionId.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % 100;
}

/** 单条规则是否命中（match 中所有已声明的条件都必须满足；未声明条件不约束） */
function ruleMatches(rule: FlagRule<unknown>, ctx: FlagContext): boolean {
    const match = rule.match;
    if (!match) {
        return true;
    }
    if (match.userIdIn) {
        if (ctx.userId === undefined || !match.userIdIn.includes(ctx.userId)) {
            return false;
        }
    }
    if (match.goalTagIn) {
        const goal = ctx.goalTags ?? [];
        if (!match.goalTagIn.some((tag) => goal.includes(tag))) {
            return false;
        }
    }
    if (match.turnTagIn) {
        const turn = ctx.turnTags ?? [];
        if (!match.turnTagIn.some((tag) => turn.includes(tag))) {
            return false;
        }
    }
    if (match.bucketRange) {
        const bucket = hashToBucket(ctx.sessionId);
        const [lo, hi] = match.bucketRange;
        if (bucket < lo || bucket > hi) {
            return false;
        }
    }
    return true;
}

export interface FlagEvaluation {
    value: unknown;
    /** 命中的规则来源；未命中任何规则时为 undefined（取默认值） */
    matchedRuleSource?: string;
}

/** 求值单个 Flag：按声明顺序返回第一条命中的规则，否则取默认值 */
export function evaluateFlag<T>(
    definition: FeatureFlagDefinition<T>,
    ctx: FlagContext,
): FlagEvaluation {
    for (const rule of definition.rules ?? []) {
        if (ruleMatches(rule as FlagRule<unknown>, ctx)) {
            return { value: rule.value, matchedRuleSource: rule.source };
        }
    }
    return { value: definition.defaultValue };
}

/**
 * 对一组 Flag 求值并冻结为 FlagSnapshot。
 * Session 内只应调用一次（求值一次、全程冻结，v1.2 §3.7）。
 */
export function createFlagSnapshot(
    definitions: FeatureFlagDefinition[],
    ctx: FlagContext,
): FlagSnapshot {
    const values: Record<string, unknown> = {};
    const trace: FlagSnapshot['trace'] = [];
    for (const def of definitions) {
        const { value, matchedRuleSource } = evaluateFlag(def, ctx);
        values[def.key] = value;
        trace.push({ key: def.key, matchedRule: matchedRuleSource, resolvedValue: value });
    }
    const frozen = Object.freeze({ ...values });
    return {
        values: frozen as Record<string, unknown>,
        trace: trace.map((entry) => ({ ...entry })),
        isEnabled(key: string): boolean {
            return frozen[key] === true;
        },
        getNumber(key: string): number | undefined {
            const v = frozen[key];
            return typeof v === 'number' ? v : undefined;
        },
        getString(key: string): string | undefined {
            const v = frozen[key];
            return typeof v === 'string' ? v : undefined;
        },
    };
}
