/**
 * round-types —— 单次 LLM 轮次的契约类型（goal 路径与旧 executor 共用）。
 * 仅依赖 core provider 契约（LLMMessage/ToolSchema/VendorUsage），不依附 Session/Turn 旧模型。
 * goal-executor 从旧 executor.ts 迁出后只依赖本模块。
 */

import type { LLMMessage, ToolSchema, VendorUsage } from '@mazi/core';

/** 单次 LLM 轮次请求（新 provider 契约 Block 消息；容量中的模型已选定） */
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
    vendorUsage?: VendorUsage;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
}
