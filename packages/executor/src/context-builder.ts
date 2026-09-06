import type { LLMContext, LLMMessage, Step, ToolSpec } from '@mazi/core';
import type { ContextSections } from '@mazi/usage';

/**
 * 将已完成的 Steps 重建为下一轮模型请求的上下文段（MVP 口径）：
 * - 每轮模型调用前构建一次；history 覆盖到当前已完成 Steps；
 * - 具体消息映射：thinking(assistant 文本) → assistant；tool_call → assistant(tool 意图)；
 *   observation → tool 结果消息。
 */
export function buildContextMessages(steps: Step[]): LLMMessage[] {
    const messages: LLMMessage[] = [];
    for (const step of steps) {
        if (step.status !== 'ok') {
            continue;
        }
        switch (step.kind) {
            case 'thinking': {
                const content = (step.payload as { content?: string }).content ?? '';
                if (content.length > 0) {
                    messages.push({ role: 'assistant', content });
                }
                break;
            }
            case 'tool_call': {
                const p = step.payload as { toolName: string; callId?: string };
                messages.push({
                    role: 'assistant',
                    content: '',
                    name: p.toolName,
                    toolCallId: p.callId,
                });
                break;
            }
            case 'observation': {
                const p = step.payload as {
                    toolName?: string;
                    content: string;
                    contextContent?: string;
                    isError?: boolean;
                };
                const content = p.contextContent ?? p.content;
                messages.push({
                    role: 'tool',
                    content: p.isError ? `[error] ${content}` : content,
                    name: p.toolName,
                });
                break;
            }
        }
    }
    return messages;
}

export interface BuildContextInput {
    systemPrompt?: string;
    steps: Step[];
    newInput: string;
    tools: ToolSpec[];
}

export interface BuiltContext {
    sections: ContextSections;
    context: LLMContext;
}

/** 上下文分段（供采集点 A ContextMeter 计数）；obs/retrieved/examples 段 MVP 以最近观测近似 */
export function buildContext(input: BuildContextInput): BuiltContext {
    const { systemPrompt = '', steps, newInput, tools } = input;
    const messages = buildContextMessages(steps);
    const historyText = messages.map((m) => `${m.role}: ${m.content} ${m.name ?? ''}`).join('\n');
    const latestObservation = [...steps]
        .reverse()
        .find((s) => s.kind === 'observation' && s.status === 'ok');
    const observationPayload = latestObservation?.payload as
        | { content?: string; contextContent?: string }
        | undefined;
    const observationText = observationPayload?.contextContent ?? observationPayload?.content ?? '';
    const sections: ContextSections = {
        systemPrompt,
        history: historyText,
        toolSchema: JSON.stringify(tools),
        newInput,
        observation: observationText,
    };
    return {
        sections,
        context: {
            systemPrompt: systemPrompt.length > 0 ? systemPrompt : undefined,
            messages,
            tools,
        },
    };
}
