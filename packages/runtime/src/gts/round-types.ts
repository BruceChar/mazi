/**
 * round-types —— 单次 LLM 轮次的契约类型。
 * 仅依赖 core provider 契约（LLMMessage/ToolSchema/VendorUsage）。
 * goal-executor 从旧 executor.ts 迁出后只依赖本模块。
 */

import type {
    CostBreakdown,
    LLMMessage,
    RuntimeContextBreakdown,
    ToolSchema,
    VendorUsage,
} from '@mazi/core';

/** 单次 LLM 轮次请求 */
export interface ExecutorRoundContext {
    model: { providerId: string; modelId: string };
    messages: LLMMessage[];
    systemPrompt?: string;
    tools: ToolSchema[];
    signal?: AbortSignal;
    /** 归因：本轮所属 work goal（流式事件 rootGoalId 之外的 goalId） */
    goalId?: string;
    /** 归因：本轮所属 task（llm.stream_event 为 Task 级事件，必须携带） */
    taskId?: string;
}

export interface RoundToolCall {
    callId: string;
    toolName: string;
    arguments: Record<string, unknown>;
}

/** Runtime 输出侧估算与漂移（core UsageEstimate 的轮次形态） */
export interface RoundEstimate {
    /** 非 reasoning 输出文本的 token 估算 */
    outputTokens: number;
    /** outputTokens − (vendor.output − vendor.reasoning) */
    outputDriftTokens?: number;
    outputDriftRate?: number;
}

/** 一轮执行结果（Step 回注所需的最小事实面；provider-runtime 或测试 fake 映射后注入） */
export interface RoundResult {
    text: string;
    reasoning: string;
    toolCalls: RoundToolCall[];
    /** 厂商上报用量（provider response.usage 归一） */
    vendorUsage?: VendorUsage;
    /** 本轮成本拆分（provider 层计价；无计价表时缺省） */
    cost?: CostBreakdown;
    /** Runtime 输入估算（system/user/assistant/tool-call/schema/input/observation） */
    contextUsage?: RuntimeContextBreakdown;
    /** Runtime 输出估算与漂移 */
    estimate?: RoundEstimate;
    /** 以估算 token 重算的成本（对照） */
    estimatedCost?: CostBreakdown;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
}
