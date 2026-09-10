/**
 * StreamAggregator —— 实现 AHF_RUNTIME_PROVIDER §3（[CORE §7.3] 聚合语义）。
 *
 * 把 Adapter 的 askStream 事件流聚合成一条 LLMResponse，并打点 TTFT / e2e。
 * 语义：
 *   - text_delta / reasoning_delta 各自拼接成单块，按“到达顺序”在不同种类间如实排序；
 *   - tool call 按 index 分组：start 建槽、delta 追加 JSON 片段、stop 封槽后 JSON.parse；
 *   - 畸形工具调用：单个丢弃其余照常；全部畸形或 finishReason='tool_calls' 却无合法
 *     工具调用 → 抛 ProviderError('unknown')（不静默产出“正常”响应）；
 *   - 空 content 且无 toolCalls → TextBlock('') 占位。
 *
 * 序列不变量（[CORE §7.2]）的硬断言器属 core（EventSequenceValidator，validation-tool.ts），
 * 待 core 导出后在此接入；当前按容错解析实现，不吞上游异常。
 */

import type {
    LLMFinishReason,
    LLMResponse,
    ReasoningBlock,
    StreamCompletionEvent,
    TextBlock,
    TokenUsage,
    ToolCall,
} from '@mazi/core';
import { ProviderError } from '@mazi/core';

export interface RoundTimers {
    /** ask/askStream 发起时刻（打点基准） */
    startedAt: number;
    /** 首个内容事件到达时刻；聚合器写入 */
    firstEventAt?: number;
    /** finish 到达或异常时刻；聚合器写入 */
    endedAt?: number;
}

export interface AggregatedRound {
    response: LLMResponse;
    /** firstEventAt − startedAt；无内容事件（纯 usage）时缺省 */
    ttftMs?: number;
    /** endedAt − startedAt */
    totalMs: number;
}

/** 内容段：text 与 reasoning 交错时按到达顺序如实保留 */
type Segment = { kind: 'text'; text: string } | { kind: 'reasoning'; text: string };

interface ToolSlot {
    callId?: string;
    name?: string;
    argsJson: string;
    /** stop 封槽成功后的合法 ToolCall（畸形则为 undefined） */
    parsed?: ToolCall;
    malformed?: boolean;
}

/**
 * 聚合一次 askStream 事件流为 AggregatedRound。
 * 事件流自身抛出的异常（含 [CORE §8.8] 已分类的 ProviderError）原样上抛；
 * 畸形工具调用的拒绝规则见文件头与 §3.3。
 *
 * @param onEvent 可选观测钩子：每个原始流式事件按到达顺序同步回调（流式 UI 转发用），
 *                必须无副作用、不抛异常；不影响聚合结果。
 */
export async function aggregateStream(
    events: AsyncIterable<StreamCompletionEvent>,
    timers: RoundTimers,
    onEvent?: (event: StreamCompletionEvent) => void,
): Promise<AggregatedRound> {
    const now = (): number => Date.now();
    let firstContentAt: number | undefined;
    let endedAt: number | undefined;
    let finishReason: LLMFinishReason | undefined;
    let rawFinishReason: string | undefined;
    let usage: TokenUsage | undefined;
    let model = '';
    let responseId: string | undefined;

    let current: Segment | undefined;
    const segments: Segment[] = [];
    const slots = new Map<number, ToolSlot>();
    const slotOrder: number[] = [];
    const sawToolCall = { value: false };

    const touchFirstContent = (): void => {
        if (firstContentAt === undefined) firstContentAt = now();
    };
    const append = (kind: 'text' | 'reasoning', delta: string): void => {
        if (current === undefined || current.kind !== kind) {
            if (current !== undefined) segments.push(current);
            current = { kind, text: delta };
        } else {
            current.text += delta;
        }
        touchFirstContent();
    };
    const ensureSlot = (index: number): ToolSlot => {
        let slot = slots.get(index);
        if (slot === undefined) {
            slot = { argsJson: '' };
            slots.set(index, slot);
            slotOrder.push(index);
        }
        return slot;
    };

    for await (const event of events) {
        onEvent?.(event);
        switch (event.type) {
            case 'start':
                model = event.model ?? model;
                responseId = event.responseId ?? responseId;
                break;
            case 'text_delta':
                append('text', event.text);
                break;
            case 'reasoning_delta':
                append('reasoning', event.reasoning);
                break;
            case 'tool_call_start': {
                sawToolCall.value = true;
                const slot = ensureSlot(event.index);
                if (event.callId !== undefined) slot.callId = event.callId;
                if (event.name !== undefined) slot.name = event.name;
                touchFirstContent();
                break;
            }
            case 'tool_call_delta': {
                sawToolCall.value = true;
                ensureSlot(event.index).argsJson += event.argumentsDelta ?? '';
                touchFirstContent();
                break;
            }
            case 'tool_call_stop': {
                sawToolCall.value = true;
                const slot = ensureSlot(event.index);
                slot.callId = slot.callId ?? '';
                slot.name = slot.name ?? '';
                try {
                    const parsed = JSON.parse(slot.argsJson);
                    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        throw new Error('tool arguments must be a JSON object');
                    }
                    slot.parsed = {
                        callId: slot.callId ?? '',
                        name: slot.name ?? '',
                        arguments: parsed as Record<string, unknown>,
                    };
                } catch {
                    // 单个畸形：丢弃该条，其余照常（§3.3）
                    slot.malformed = true;
                }
                break;
            }
            case 'usage':
                usage = event.usage;
                break;
            case 'finish':
                finishReason = event.finishReason;
                rawFinishReason = event.rawFinishReason;
                endedAt = now();
                break;
            default:
                break;
        }
    }

    if (current !== undefined) segments.push(current);
    endedAt = endedAt ?? now();
    timers.firstEventAt = firstContentAt;
    timers.endedAt = endedAt;

    // 合法工具调用（按槽位首次出现顺序）
    const toolCalls: ToolCall[] = [];
    for (const index of slotOrder) {
        const slot = slots.get(index);
        if (slot?.parsed !== undefined) toolCalls.push(slot.parsed);
    }

    // §3.3：tool_calls 收尾但无任何合法调用 → 拒绝，不静默产出正常响应
    if (sawToolCall.value && finishReason === 'tool_calls' && toolCalls.length === 0) {
        throw new ProviderError(
            'unknown',
            'stream ended with finishReason=tool_calls but no valid tool call could be parsed',
        );
    }

    // content：segments → blocks（text / reasoning 交错保序）
    const content: (TextBlock | ReasoningBlock)[] = segments.map((segment) =>
        segment.kind === 'text'
            ? { type: 'text', text: segment.text }
            : { type: 'reasoning', text: segment.text },
    );
    // §3.2.3：空 content 且无 toolCalls → TextBlock('') 占位
    if (content.length === 0 && toolCalls.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    const response: LLMResponse = {
        model,
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(usage !== undefined ? { usage } : {}),
        finishReason: finishReason ?? 'other',
        ...(rawFinishReason !== undefined ? { rawFinishReason } : {}),
        ...(responseId !== undefined ? { id: responseId } : {}),
    };

    return {
        response,
        ttftMs: firstContentAt !== undefined ? firstContentAt - timers.startedAt : undefined,
        totalMs: endedAt - timers.startedAt,
    };
}
