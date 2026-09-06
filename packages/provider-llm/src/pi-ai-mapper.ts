import type {
    AssistantMessage,
    AssistantMessageEvent,
    Context,
    Message,
    Tool,
    ToolResultMessage,
    TSchema,
    Usage,
} from '@earendil-works/pi-ai';
import type { LLMMessage, LLMStreamEvent, ToolSpec, VendorUsage } from '@mazi/core';

/** 重建历史 assistant 消息所需的模型元信息 */
export interface PiModelMeta {
    api: string;
    provider: string;
    model: string;
}

const EMPTY_USAGE = (): Usage => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** ToolSpec → pi-ai Tool（parameters 为 JSON-schema 子集对象，按 TSchema 透传） */
export function toolsToPi(tools: ToolSpec[]): Tool[] {
    return tools.map((tool) => ({
        name: sanitizeToolName(tool.name),
        description: tool.description,
        parameters: tool.parameters as unknown as TSchema,
    }));
}

/**
 * OpenAI/DeepSeek Chat Completions 的 function.name 仅允许 ^[a-zA-Z0-9_-]+$；
 * 防腐层在发往厂商前把非法字符替换为 '_'（如 fs.read → fs_read）。
 */
export function sanitizeToolName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 由厂商返回的清洗后工具名还原原始工具名；无匹配时原样返回。 */
export function restoreSanitizedToolName(name: string, tools: ToolSpec[]): string {
    const matched = tools.find((tool) => sanitizeToolName(tool.name) === name);
    return matched?.name ?? name;
}

/**
 * LLMMessage → pi-ai Message。
 * - role=user / assistant(纯文本) 直接映射；
 * - role=assistant 且携带 toolCallId 的工具意图条目跳过（后续 toolResult 已含 toolName/toolCallId/isError）；
 * - role=tool → ToolResultMessage（content 前缀 '[error] ' 判定 isError）。
 */
export function messagesToPi(
    messages: LLMMessage[],
    meta: PiModelMeta,
    now: () => number = Date.now,
): Message[] {
    const result: Message[] = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            continue;
        }
        if (msg.role === 'user') {
            result.push({ role: 'user', content: msg.content, timestamp: now() });
            continue;
        }
        if (msg.role === 'assistant') {
            if (msg.toolCallId !== undefined || msg.name !== undefined) {
                // 工具意图无 arguments 信息，依赖紧随其后的 tool 结果还原调用
                continue;
            }
            const assistant: AssistantMessage = {
                role: 'assistant',
                content: [{ type: 'text', text: msg.content }],
                api: meta.api,
                provider: meta.provider,
                model: meta.model,
                usage: EMPTY_USAGE(),
                stopReason: 'stop',
                timestamp: now(),
            };
            result.push(assistant);
            continue;
        }
        // role === 'tool'
        const isError = msg.content.startsWith('[error] ');
        const toolResult: ToolResultMessage = {
            role: 'toolResult',
            toolCallId: msg.toolCallId ?? 'call-unknown',
            toolName: sanitizeToolName(msg.name ?? 'tool'),
            content: [
                {
                    type: 'text',
                    text: isError ? msg.content.slice('[error] '.length) : msg.content,
                },
            ],
            isError,
            timestamp: now(),
        };
        result.push(toolResult);
    }
    return result;
}

/** 组装 pi-ai Context（systemPrompt 取首条 system 消息内容） */
export function buildPiContext(input: {
    systemPrompt?: string;
    messages: LLMMessage[];
    tools: ToolSpec[];
    meta: PiModelMeta;
}): Context {
    const sys = input.messages.find((m) => m.role === 'system');
    return {
        systemPrompt: input.systemPrompt ?? sys?.content,
        messages: messagesToPi(input.messages, input.meta),
        tools: input.tools.length > 0 ? toolsToPi(input.tools) : undefined,
    };
}

/** pi-ai Usage → VendorUsage（厂商口径；reasoning 细分由 pi-ai 提供时透传） */
export function toVendorUsage(usage: Usage): VendorUsage {
    return {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadInputTokens: usage.cacheRead > 0 ? usage.cacheRead : undefined,
        cacheCreationInputTokens: usage.cacheWrite > 0 ? usage.cacheWrite : undefined,
        reasoningOutputTokens: usage.reasoning !== undefined ? usage.reasoning : undefined,
        reportedByVendor: true,
    };
}

/** pi-ai stopReason → harness finishReason */
export function mapFinishReason(stopReason: AssistantMessage['stopReason']): string {
    switch (stopReason) {
        case 'toolUse':
            return 'tool_calls';
        case 'stop':
            return 'stop';
        case 'length':
            return 'length';
        default:
            return stopReason;
    }
}

/** 翻译单条 pi-ai 事件为 harness LLMStreamEvent 序列；error 事件直接抛错（driver-error 语义） */
export function translatePiEvent(event: AssistantMessageEvent): LLMStreamEvent[] {
    switch (event.type) {
        case 'text_delta':
            return [{ type: 'text-delta', delta: event.delta }];
        case 'thinking_delta':
            return [{ type: 'reasoning-delta', delta: event.delta }];
        case 'toolcall_end':
            return [
                {
                    type: 'tool-call',
                    callId: event.toolCall.id,
                    toolName: event.toolCall.name,
                    arguments: event.toolCall.arguments,
                },
            ];
        case 'done': {
            const usage = toVendorUsage(event.message.usage);
            return [
                { type: 'usage', usage },
                { type: 'end', finishReason: mapFinishReason(event.message.stopReason) },
            ];
        }
        case 'error': {
            const message = event.error.errorMessage ?? `pi-ai 请求失败：${event.reason}`;
            throw new Error(message);
        }
        default:
            return [];
    }
}
