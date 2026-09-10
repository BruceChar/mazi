/**
 * round-types —— 单次 LLM 轮次的契约类型。
 * 仅依赖 core provider 契约（LLMMessage/ToolSchema/VendorUsage）。
 * goal-executor 从旧 executor.ts 迁出后只依赖本模块。
 */

import type { LLMMessage, RuntimeContextBreakdown, ToolSchema, VendorUsage } from '@mazi/core';

/** 单次 LLM 轮次请求 */
export interface ExecutorRoundContext {
    model: { providerId: string; modelId: string };
    messages: LLMMessage[];
    systemPrompt?: string;
    tools: ToolSchema[];
    signal?: AbortSignal;
}

export interface RoundToolCall {
    callId: string;
    toolName: string;
    arguments: Record<string, unknown>;
}

/** 一轮执行结果（Step 回注所需的最小事实面；provider-runtime 或测试 fake 映射后注入） */
export interface RoundResult {
    text: string;
    reasoning: string;
    toolCalls: RoundToolCall[];
    /** 厂商上报用量（provider response.usage 归一） */
    vendorUsage?: VendorUsage;
    /** Runtime 上下文分段估算（C3e：system/history/tool/input/observation token） */
    contextUsage?: RuntimeContextBreakdown;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
}
