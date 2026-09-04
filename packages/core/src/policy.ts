import type { Capacity } from './capacity.js';

/** 工具调用策略判定结果 */
export interface PolicyVerdict {
    pass: boolean;
    /** 拒绝原因，pass=true 时可缺省 */
    reason?: string;
}

/** Policy Engine 接口（MVP：工具白名单/权限/schema/预算，无审批门） */
export interface PolicyEngine {
    checkToolCall(
        capacity: Capacity,
        toolName: string,
        args: Record<string, unknown>,
        estimatedCostUsd?: number,
    ): Promise<PolicyVerdict>;
}
