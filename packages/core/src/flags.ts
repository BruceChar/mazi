/** Flag 定义 */
export interface FeatureFlagDefinition<T = boolean | number | string> {
    key: string;
    description: string;
    type: 'boolean' | 'number' | 'string';
    defaultValue: T;
    /** 按优先级依次求值 */
    rules?: FlagRule<T>[];
}

/** Flag 求值规则 */
export interface FlagRule<T> {
    /** 命中条件（所有条件 AND） */
    match?: {
        userIdIn?: string[];
        /** 匹配 GoalContract.strategyHints */
        goalTagIn?: string[];
        /** 匹配 TurnContract.tags（Turn 级 flag 用） */
        turnTagIn?: string[];
        /** sessionId 哈希分桶 0-99，A/B 用 */
        bucketRange?: [number, number];
    };
    value: T;
    /** 审计用规则来源 */
    source: string;
}

/** Session 内冻结的 Flag 快照 */
export interface FlagSnapshot {
    values: Record<string, unknown>;
    /** 求值 trace，便于复盘 */
    trace: {
        key: string;
        matchedRule?: string;
        resolvedValue: unknown;
    }[];
    isEnabled(key: string): boolean;
    getNumber(key: string): number | undefined;
    getString(key: string): string | undefined;
}
