import type { LLMRound, LLMStreamEvent, ToolCallStreamEvent } from '@mazi/core';

/** 归一一次 LLM 轮次：流式事件 → Executor/Observer 共用的 LLMRound */
export function collectLLMRound(
    events: Iterable<LLMStreamEvent>,
    startedAt: number,
    now: () => number,
): LLMRound {
    const text: string[] = [];
    const reasoning: string[] = [];
    const toolCalls: ToolCallStreamEvent[] = [];
    let vendorUsage: LLMRound['vendorUsage'];
    let finishReason: string | undefined;
    let firstTextAt: number | undefined;
    for (const event of events) {
        switch (event.type) {
            case 'text-delta':
                if (firstTextAt === undefined) {
                    firstTextAt = now();
                }
                text.push(event.delta);
                break;
            case 'reasoning-delta':
                reasoning.push(event.delta);
                break;
            case 'tool-call':
                toolCalls.push(event);
                break;
            case 'usage':
                vendorUsage = event.usage;
                break;
            case 'end':
                finishReason = event.finishReason;
                break;
        }
    }
    return {
        text: text.join(''),
        reasoning: reasoning.join(''),
        toolCalls,
        vendorUsage,
        finishReason,
        ttftMs: firstTextAt === undefined ? 0 : firstTextAt - startedAt,
        totalMs: now() - startedAt,
    };
}
