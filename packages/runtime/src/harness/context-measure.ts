import type { LLMRequest, RuntimeContextBreakdown, ToolSchema } from '@mazi/core';
import { estimateTokens } from '../token-estimator.js';

/** 单段原文截断上限（字符）；仅审计展示，避免 payload 过大 */
export const SEGMENT_CONTENT_MAX = 4000;
/** diff 原文截断上限（字符） */
export const DIFF_CONTENT_MAX = 8000;

export function truncateText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

/**
 * 上下文分段计量（runtime input 估算）：system / user history / assistant / tool-call args /
 * tool schema / new input / observation → RuntimeContextBreakdown。文本用真实 tokenizer 估算，
 * 同时保留各段原文（截断）与相对上一轮新增内容（diffContent，按消息边界取增量）。
 */
export function measureContext(
    ctx: {
        messages: LLMRequest['messages'];
        systemPrompt?: string;
        tools: ToolSchema[];
    },
    prevTotal: number | undefined,
    prevMessageCount: number | undefined,
    contextWindow: number,
): RuntimeContextBreakdown {
    const textOf = (content: readonly { type: string; text?: string }[]): string =>
        content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
    const messages = ctx.messages;
    let newInputTokens = 0;
    let observationTokens = 0;
    let historyUserTokens = 0;
    let historyAssistantTokens = 0;
    let toolCallTokens = 0;
    const parts = {
        systemPrompt: '',
        historyUser: '',
        historyAssistant: '',
        toolCalls: '',
        toolSchema: '',
        newInput: '',
        observation: '',
        retrieved: '',
        examples: '',
    };
    const diffParts: string[] = [];
    const diffByKey = {
        systemPrompt: '',
        historyUser: '',
        historyAssistant: '',
        toolCalls: '',
        toolSchema: '',
        newInput: '',
        observation: '',
        retrieved: '',
        examples: '',
    };
    // 本 Task 首轮（含续聊 Session 的首轮）：prevTotal 为 undefined；
    // 此时 system prompt / tool schema 视为全量新增。
    const isFirst = prevTotal === undefined;
    for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        if (message === undefined) continue;
        const added = prevMessageCount === undefined || i >= prevMessageCount;
        if (message.role === 'user') {
            const text = textOf(message.content);
            if (i === messages.length - 1) {
                newInputTokens = estimateTokens(text);
                parts.newInput += text;
                diffByKey.newInput += text;
                diffParts.push(text);
            } else {
                historyUserTokens += estimateTokens(text);
                parts.historyUser += `${text}\n\n`;
                if (added) {
                    diffByKey.historyUser += `${text}\n\n`;
                    diffParts.push(`[user]\n${text}`);
                }
            }
        } else if (message.role === 'tool') {
            for (const result of message.results) {
                const text =
                    typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output);
                observationTokens += estimateTokens(text);
                parts.observation += `${text}\n\n`;
                if (added) {
                    diffByKey.observation += `${text}\n\n`;
                    diffParts.push(`[tool result]\n${text}`);
                }
            }
        } else if (message.role === 'assistant') {
            const text = textOf(message.content);
            historyAssistantTokens += estimateTokens(text);
            parts.historyAssistant += `${text}\n\n`;
            if (added) {
                diffByKey.historyAssistant += `${text}\n\n`;
                diffParts.push(`[assistant]\n${text}`);
            }
            for (const call of message.toolCalls ?? []) {
                const json = JSON.stringify(call);
                toolCallTokens += estimateTokens(json);
                parts.toolCalls += `${json}\n`;
                if (added) {
                    diffByKey.toolCalls += `${json}\n`;
                    diffParts.push(`[tool call]\n${json}`);
                }
            }
        }
    }
    parts.systemPrompt = ctx.systemPrompt ?? '';
    parts.toolSchema = JSON.stringify(ctx.tools ?? []);
    // 首轮：system prompt / tool schema 视为「全量新增」，之后默认不变
    if (isFirst) {
        diffByKey.systemPrompt = parts.systemPrompt;
        diffByKey.toolSchema = parts.toolSchema;
    }
    const systemPromptTokens = estimateTokens(parts.systemPrompt);
    const toolSchemaTokens = estimateTokens(parts.toolSchema);
    const historyTokens = historyUserTokens + historyAssistantTokens + toolCallTokens;
    const totalContextTokens =
        systemPromptTokens + historyTokens + toolSchemaTokens + newInputTokens + observationTokens;
    const contextWindowUtilization =
        contextWindow > 0 ? Math.min(1, totalContextTokens / contextWindow) : 0;
    // 实际装配字节数（UTF-8）：与 token 估算口径独立，落库为原始事实。
    const contextBytes =
        Buffer.byteLength(parts.systemPrompt, 'utf8') +
        Buffer.byteLength(parts.toolSchema, 'utf8') +
        Buffer.byteLength(parts.historyUser, 'utf8') +
        Buffer.byteLength(parts.historyAssistant, 'utf8') +
        Buffer.byteLength(parts.toolCalls, 'utf8') +
        Buffer.byteLength(parts.newInput, 'utf8') +
        Buffer.byteLength(parts.observation, 'utf8');
    return {
        systemPromptTokens,
        systemPromptRatio: totalContextTokens > 0 ? systemPromptTokens / totalContextTokens : 0,
        historyTokens,
        historyUserTokens,
        historyAssistantTokens,
        toolCallTokens,
        toolSchemaTokens,
        newInputTokens,
        observationTokens,
        retrievedTokens: 0,
        exampleTokens: 0,
        totalContextTokens,
        contextBytes,
        contextWindowTokens: contextWindow,
        contextWindowUtilization,
        contextDeltaFromPrev: prevTotal === undefined ? 0 : totalContextTokens - prevTotal,
        strategyApplied: [],
        contents: {
            systemPrompt: truncateText(parts.systemPrompt, SEGMENT_CONTENT_MAX),
            historyUser: truncateText(parts.historyUser, SEGMENT_CONTENT_MAX),
            historyAssistant: truncateText(parts.historyAssistant, SEGMENT_CONTENT_MAX),
            toolCalls: truncateText(parts.toolCalls, SEGMENT_CONTENT_MAX),
            toolSchema: truncateText(parts.toolSchema, SEGMENT_CONTENT_MAX),
            newInput: truncateText(parts.newInput, SEGMENT_CONTENT_MAX),
            observation: truncateText(parts.observation, SEGMENT_CONTENT_MAX),
            retrieved: '',
            examples: '',
        },
        diffContent: truncateText(diffParts.join('\n\n'), DIFF_CONTENT_MAX),
        diffContents: {
            systemPrompt: truncateText(diffByKey.systemPrompt, SEGMENT_CONTENT_MAX),
            historyUser: truncateText(diffByKey.historyUser, SEGMENT_CONTENT_MAX),
            historyAssistant: truncateText(diffByKey.historyAssistant, SEGMENT_CONTENT_MAX),
            toolCalls: truncateText(diffByKey.toolCalls, SEGMENT_CONTENT_MAX),
            toolSchema: truncateText(diffByKey.toolSchema, SEGMENT_CONTENT_MAX),
            newInput: truncateText(diffByKey.newInput, SEGMENT_CONTENT_MAX),
            observation: truncateText(diffByKey.observation, SEGMENT_CONTENT_MAX),
            retrieved: '',
            examples: '',
        },
    };
}
