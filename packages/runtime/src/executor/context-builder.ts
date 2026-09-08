/**
 * context-builder —— 将已完成 Steps 重建为下一轮 LLM 请求（provider.ts Block 消息模型）。
 * 每轮模型调用前构建一次；history 覆盖当前已完成 Steps：
 *   thinking → assistant.content:[{type:'text'}]；tool_call → assistant.toolCalls[]；
 *   observation → tool.results[{callId, output, isError}]。
 */

import type { LLMMessage, Step, ToolSchema, ToolSpec } from '@mazi/core';
import type { ContextSections } from '../usage/index.js';

/** 一轮 LLM 请求的上下文（不含 model 选择，model 由容量/执行层给出） */
export interface RoundContextRequest {
    systemPrompt?: string;
    messages: LLMMessage[];
    tools: ToolSchema[];
}

/** 将已完成 Steps 重建为 Block 消息序列 */
export function buildContextMessages(steps: Step[]): LLMMessage[] {
    const messages: LLMMessage[] = [];
    let pendingToolCallId: string | undefined;
    for (const step of steps) {
        if (step.status !== 'ok') {
            continue;
        }
        switch (step.kind) {
            case 'thinking': {
                const payload = step.payload as { content?: string; contextContent?: string };
                const content = payload.contextContent ?? payload.content ?? '';
                if (content.length > 0) {
                    messages.push({
                        role: 'assistant',
                        content: [{ type: 'text', text: content }],
                    });
                }
                break;
            }
            case 'tool_call': {
                const p = step.payload as {
                    toolName: string;
                    callId?: string;
                    arguments?: Record<string, unknown>;
                };
                const callId = p.callId ?? `call-${messages.length}`;
                messages.push({
                    role: 'assistant',
                    content: [],
                    toolCalls: [{ callId, name: p.toolName, arguments: p.arguments ?? {} }],
                });
                pendingToolCallId = callId;
                break;
            }
            case 'observation': {
                const p = step.payload as {
                    toolName?: string;
                    content: string;
                    contextContent?: string;
                    isError?: boolean;
                    toolCallId?: string;
                };
                const content = p.contextContent ?? p.content ?? '';
                const callId = p.toolCallId ?? pendingToolCallId ?? ``;
                const result: Extract<LLMMessage, { role: 'tool' }>['results'][number] = {
                    callId,
                    output: content,
                    ...(p.isError ? { isError: true } : {}),
                };
                messages.push({
                    role: 'tool',
                    results: [result],
                    ...(p.toolName ? { name: p.toolName } : {}),
                });
                break;
            }
        }
    }
    return messages;
}

/** 消息 → 单行文本（供 ContextMeter 分段计数与审计） */
function messageToText(message: LLMMessage): string {
    const blocks =
        'content' in message && Array.isArray(message.content)
            ? (message.content as { type?: string; text?: string; thinking?: string }[])
                  .map((b) =>
                      b.type === 'text'
                          ? (b.text ?? '')
                          : b.type === 'reasoning'
                            ? (b.text ?? '')
                            : '',
                  )
                  .join('')
            : '';
    if (message.role === 'tool') {
        const outputs = message.results
            .map((r) => (typeof r.output === 'string' ? r.output : JSON.stringify(r.output)))
            .join('\n');
        return `tool: ${outputs}`;
    }
    if (message.role === 'assistant') {
        const calls = (message.toolCalls ?? []).map((c) => c.name).join(',');
        return `assistant: ${blocks} ${calls}`;
    }
    return `${message.role}: ${blocks}`;
}

/** 旧工具规格 → provider 工具 schema（name/description/parameters） */
function toToolSchema(tool: ToolSpec): ToolSchema {
    const parameters =
        tool.parameters !== undefined &&
        typeof tool.parameters === 'object' &&
        tool.parameters !== null
            ? (tool.parameters as Record<string, unknown>)
            : undefined;
    return {
        name: tool.name,
        description: tool.description,
        ...(parameters !== undefined ? { parameters } : {}),
    };
}

export interface BuildContextInput {
    systemPrompt?: string;
    steps: Step[];
    newInput: string;
    tools: ToolSpec[];
}

export interface BuiltContext {
    sections: ContextSections;
    context: RoundContextRequest;
}

/** 上下文分段（供采集点 A ContextMeter 计数）；obs/retrieved/examples 段 MVP 以最近观测近似 */
export function buildContext(input: BuildContextInput): BuiltContext {
    const { systemPrompt = '', steps, newInput, tools } = input;
    const history = buildContextMessages(steps);
    // 用户原始输入必须先进入 LLM 消息，而不是只出现在上下文计分段
    const messages: LLMMessage[] =
        newInput.trim().length > 0
            ? [{ role: 'user', content: [{ type: 'text', text: newInput }] }, ...history]
            : history;
    const historyText = messages.map((m) => messageToText(m)).join('\n');
    const latestObservation = [...steps]
        .reverse()
        .find((s) => s.kind === 'observation' && s.status === 'ok');
    const observationPayload = latestObservation?.payload as
        | { content?: string; contextContent?: string }
        | undefined;
    const observationText = observationPayload?.contextContent ?? observationPayload?.content ?? '';
    const toolSchemas = tools.map(toToolSchema);
    const sections: ContextSections = {
        systemPrompt,
        history: historyText,
        toolSchema: JSON.stringify(toolSchemas),
        newInput,
        observation: observationText,
    };
    return {
        sections,
        context: {
            ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
            messages,
            tools: toolSchemas,
        },
    };
}
