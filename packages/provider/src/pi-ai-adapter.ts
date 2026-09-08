/**
 * pi-ai 桥接：把 @earendil-works/pi-ai 的 Models 集合适配为 @mazi/core 的 LLMProvider 契约。
 *
 * 契约要点（packages/core/src/provider.ts，规范 docs/core/AHF_CORE_PROVIDER.md）：
 *   - 双入口等价（EQUIV）：ask（非流式）与 askStream（流式）共享请求校验/能力协商/
 *     错误映射语义；ask 走 pi-ai Models.complete，askStream 走 Models.stream，
 *     两者差异只允许存在于网络收发与事件切分层。
 *   - 消息为 Block 模型：assistant 的工具调用是独立字段 toolCalls，
 *     tool 消息携带 results: ToolResult[]。
 *   - 错误统一为 ProviderError 异常：ask reject、askStream 迭代过程抛出；
 *     pi-ai 流内 error 事件在此翻译为异常终止（不做 error 事件外泄）。
 */

import type {
    Api,
    AssistantMessageEventStream,
    Context,
    ImageContent,
    Message,
    Model,
    Models,
    ModelsApiStreamOptions,
    AssistantMessage as PiAssistantMessage,
    ToolCall as PiToolCall,
    Usage as PiUsage,
    TextContent,
    ThinkingContent,
    Tool,
    TSchema,
} from '@earendil-works/pi-ai';
import { ModelsError, Type } from '@earendil-works/pi-ai';
import type {
    AssistantMessage,
    ContentBlock,
    ContentType,
    LLMFinishReason,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ProviderModel,
    ReasoningBlock,
    StreamCompletionEvent,
    TextBlock,
    TokenUsage,
    ToolCall,
    ToolMessage,
    ToolSchema,
} from '@mazi/core';
import { ProviderError } from '@mazi/core';

export interface PiAiBridgeOptions {
    /** 已注册目标厂商 provider 的 Models 集合（wiring 层负责 createModels + setProvider）。 */
    models: Models;
    /** 厂商 provider id（如 "deepseek"）。 */
    providerId: string;
    /** 缺省模型 id；LLMRequest.model 缺省时使用。 */
    defaultModel?: string;
    /** 显式 apiKey（缺省由 pi-ai 从环境 / credential store 解析）。 */
    apiKey?: string;
}

/** 厂商侧工具名须匹配 ^[a-zA-Z0-9_-]+$（DeepSeek/OpenAI 系均校验）；点号等字符映射为下划线 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolName(name: string): string {
    if (TOOL_NAME_PATTERN.test(name)) return name;
    const sanitized = name.replace(/[^a-zA-Z0-9_-]+/g, '_');
    return sanitized.length > 0 ? sanitized : 'tool';
}

/** 由 request 建 wire(厂商) → canonical 名映射；同一名直连，已 sanitize 的 wire 回映到 canonical */
function toolNameMap(request: LLMRequest): Map<string, string> {
    const map = new Map<string, string>();
    const add = (name: string): void => {
        if (!name) return;
        map.set(name, name);
        const wire = sanitizeToolName(name);
        if (wire !== name && !map.has(wire)) {
            map.set(wire, name);
        }
    };
    for (const tool of request.tools ?? []) add(tool.name);
    for (const message of request.messages) {
        if (message.role === 'assistant') {
            for (const call of message.toolCalls ?? []) add(call.name);
        }
    }
    return map;
}

function toCanonicalName(name: string, map: Map<string, string>): string {
    return map.get(name) ?? map.get(sanitizeToolName(name)) ?? name;
}

/** 创建 pi-ai 桥接：返回实现 LLMProvider 契约的对象（工厂函数，无 class）。 */
export function createPiProvider(options: PiAiBridgeOptions): LLMProvider {
    const providerId = options.providerId;
    const defaultModel = options.defaultModel ?? options.models.getModels(providerId)[0]?.id;

    const providerModels: ProviderModel[] = options.models.getModels(providerId).map((model) => ({
        id: model.id,
        name: model.name,
        capabilities: {
            supportsToolCalls: true, // pi-ai 目录只收录支持工具调用的模型
            supportsStreaming: true,
            supportsReasoning: model.reasoning,
            maxInputTokens: model.contextWindow,
            maxOutputTokens: model.maxTokens,
            inputTypes: toContentTypes(model.input),
            // LLM 模型输出文本；工具调用经 toolCalls 字段返回，不属于内容类型
            outputTypes: ['text'],
        },
    }));

    return {
        id: providerId,
        name: options.models.getProvider(providerId)?.name ?? providerId,
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        models: providerModels,

        /** 非流式调用：pi-ai complete → LLMResponse（EQUIV，§9.2）。 */
        async ask(request: LLMRequest): Promise<LLMResponse> {
            const model = resolveModel(request);
            const context = toPiContext(request, model);
            const names = toolNameMap(request);
            let message: PiAssistantMessage;
            try {
                message = await options.models.complete(model, context, toPiOptions(request));
            } catch (error) {
                throw toProviderErrorFromUnknown(error);
            }
            return toResponse(message, names);
        },

        /** 流式调用：pi-ai 事件流 → StreamCompletionEvent；错误以异常终止。 */
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            const model = resolveModel(request);
            const context = toPiContext(request, model);
            const names = toolNameMap(request);
            let stream: AssistantMessageEventStream;
            try {
                stream = options.models.stream(model, context, toPiOptions(request));
            } catch (error) {
                throw toProviderErrorFromUnknown(error);
            }
            const toolCallStarted = new Set<number>();
            try {
                for await (const event of stream) {
                    switch (event.type) {
                        case 'text_delta':
                            yield { type: 'text_delta', text: event.delta };
                            break;
                        case 'thinking_delta':
                            yield { type: 'reasoning_delta', reasoning: event.delta };
                            break;
                        case 'toolcall_start': {
                            // start 时 id/name 可能已就绪（partial 内容块）；缺失时由 delta/end 补发
                            const call = toolCallAt(event.contentIndex, event.partial);
                            if (call !== undefined && !toolCallStarted.has(event.contentIndex)) {
                                toolCallStarted.add(event.contentIndex);
                                yield {
                                    type: 'tool_call_start',
                                    index: event.contentIndex,
                                    callId: call.id,
                                    name: toCanonicalName(call.name, names),
                                };
                            }
                            break;
                        }
                        case 'toolcall_delta': {
                            // pi-ai 的 delta 是参数的 JSON 片段（与 OpenAI arguments 增量同构）；
                            // id/name 可能晚于首个 delta 出现，出现时补发 start 事件
                            const call = toolCallAt(event.contentIndex, event.partial);
                            if (call !== undefined && !toolCallStarted.has(event.contentIndex)) {
                                toolCallStarted.add(event.contentIndex);
                                yield {
                                    type: 'tool_call_start',
                                    index: event.contentIndex,
                                    callId: call.id,
                                    name: toCanonicalName(call.name, names),
                                };
                            }
                            yield {
                                type: 'tool_call_delta',
                                index: event.contentIndex,
                                argumentsDelta: event.delta,
                            };
                            break;
                        }
                        case 'toolcall_end': {
                            // 兜底：部分厂商直到收尾才给出 id/name，此时补发 start 再 stop
                            if (!toolCallStarted.has(event.contentIndex)) {
                                toolCallStarted.add(event.contentIndex);
                                yield {
                                    type: 'tool_call_start',
                                    index: event.contentIndex,
                                    callId: event.toolCall.id,
                                    name: toCanonicalName(event.toolCall.name, names),
                                };
                            }
                            yield { type: 'tool_call_stop', index: event.contentIndex };
                            break;
                        }
                        case 'done': {
                            const usage = toUsage(event.message.usage);
                            if (usage.totalTokens > 0) {
                                yield { type: 'usage', usage };
                            }
                            yield {
                                type: 'finish',
                                finishReason: mapDoneReason(event.reason),
                                ...(event.message.rawStopReason
                                    ? { rawFinishReason: event.message.rawStopReason }
                                    : {}),
                            };
                            break;
                        }
                        case 'error': {
                            // 新契约：流内失败以 ProviderError 异常终止，不外泄 error 事件
                            const message = event.error.errorMessage ?? 'LLM request failed';
                            if (event.reason === 'aborted') {
                                throw new ProviderError('aborted', message);
                            }
                            throw toProviderError(message);
                        }
                        default:
                            break; // start / *_start / *_end 无增量负载
                    }
                }
            } catch (error) {
                throw toProviderErrorFromUnknown(error);
            }
        },
    };

    /* ------------------------- 模型解析 ------------------------- */

    function resolveModel(request: LLMRequest): Model<Api> {
        const id = request.model ?? defaultModel;
        if (!id) {
            throw new ProviderError(
                'invalid_request',
                `no model specified for provider ${providerId}`,
            );
        }
        const model = options.models.getModel(providerId, id);
        if (!model) {
            throw new ProviderError(
                'invalid_request',
                `unknown model "${id}" for provider ${providerId}`,
            );
        }
        return model;
    }

    /* ------------------------- 响应映射：pi AssistantMessage → LLMResponse ------------------------- */

    function toResponse(message: PiAssistantMessage, names: Map<string, string>): LLMResponse {
        if (message.stopReason === 'error') {
            throw toProviderError(message.errorMessage ?? 'LLM request failed');
        }
        const content: (TextBlock | ReasoningBlock)[] = [];
        const toolCalls: ToolCall[] = [];
        for (const block of message.content) {
            if (block.type === 'text') {
                content.push({ type: 'text', text: block.text });
            } else if (block.type === 'thinking') {
                content.push(toReasoningBlock(block));
            } else if (block.type === 'toolCall') {
                toolCalls.push({
                    callId: block.id,
                    name: toCanonicalName(block.name, names),
                    arguments: block.arguments ?? {},
                });
            }
        }
        const usage = toUsage(message.usage);
        return {
            model: message.model,
            content,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(usage.totalTokens > 0 ? { usage } : {}),
            finishReason: mapStopReason(message.stopReason),
            ...(message.rawStopReason ? { rawFinishReason: message.rawStopReason } : {}),
            ...(message.responseId ? { id: message.responseId } : {}),
        };
    }

    /* ------------------------- 消息转换：LLMMessage[] → pi Context ------------------------- */

    function toPiContext(request: LLMRequest, model: Model<Api>): Context {
        const systemParts: string[] = [];
        const piMessages: Message[] = [];
        // 工具结果需要 toolName：从 assistant 消息的 toolCalls 建立 callId → name 索引
        const callNameById = new Map<string, string>();
        for (const message of request.messages) {
            if (message.role !== 'assistant') continue;
            for (const call of message.toolCalls ?? []) {
                callNameById.set(call.callId, call.name);
            }
        }
        for (const message of request.messages) {
            switch (message.role) {
                case 'system': {
                    const text = message.content.map((block) => block.text).join('\n');
                    if (text) systemParts.push(text);
                    break;
                }
                case 'user':
                    piMessages.push({
                        role: 'user',
                        content: toPiUserContent(message.content),
                        timestamp: message.createdAt ?? 0,
                    });
                    break;
                case 'assistant':
                    piMessages.push(toPiAssistant(message, model));
                    break;
                case 'tool':
                    piMessages.push(...toPiToolResults(message, callNameById));
                    break;
            }
        }
        const context: Context = { messages: piMessages };
        if (request.system) {
            systemParts.unshift(
                typeof request.system === 'string' ? request.system : toSystemText(request.system),
            );
        }
        if (systemParts.length > 0) {
            context.systemPrompt = systemParts.join('\n\n');
        }
        if (request.tools && request.tools.length > 0) {
            context.tools = request.tools.map(toPiTool);
        }
        return context;
    }

    function toPiUserContent(parts: ContentBlock[]): (TextContent | ImageContent)[] {
        const content: (TextContent | ImageContent)[] = [];
        for (const part of parts) {
            switch (part.type) {
                case 'text':
                    content.push({ type: 'text', text: part.text });
                    break;
                case 'image':
                    content.push({
                        type: 'image',
                        data: part.data,
                        mimeType: part.mimeType ?? 'image/png',
                    });
                    break;
                case 'reasoning':
                    break; // 用户消息中的推理片段忽略
                default:
                    throw new ProviderError(
                        'invalid_request',
                        `pi-ai bridge does not support "${part.type}" content; check model capabilities.inputTypes before sending`,
                    );
            }
        }
        return content;
    }

    function toPiAssistant(message: AssistantMessage, model: Model<Api>): PiAssistantMessage {
        const content: PiAssistantMessage['content'] = [];
        for (const part of message.content) {
            switch (part.type) {
                case 'text':
                    content.push({ type: 'text', text: part.text });
                    break;
                case 'reasoning':
                    // 厂商思考内容跨轮回传：pi 据此重放 thinking 块
                    content.push({
                        type: 'thinking',
                        thinking: part.text,
                        ...(part.signature ? { thinkingSignature: part.signature } : {}),
                    });
                    break;
                default:
                    break; // 回放消息只关心 text / reasoning
            }
        }
        // 工具调用是独立字段（契约），映射为 pi 的 toolCall 块；名字需厂商合法（wire 形式）
        for (const call of message.toolCalls ?? []) {
            content.push({
                type: 'toolCall',
                id: call.callId,
                name: sanitizeToolName(call.name),
                arguments: call.arguments,
            });
        }
        return {
            role: 'assistant',
            content,
            api: model.api,
            provider: providerId as PiAssistantMessage['provider'],
            model: model.id,
            usage: ZERO_USAGE,
            stopReason: 'stop',
            timestamp: message.createdAt ?? 0,
        };
    }

    function toPiToolResults(message: ToolMessage, callNameById: Map<string, string>): Message[] {
        const results: Message[] = [];
        for (const result of message.results) {
            results.push({
                role: 'toolResult',
                toolCallId: result.callId,
                toolName: sanitizeToolName(callNameById.get(result.callId) ?? message.name ?? ''),
                content: [{ type: 'text', text: stringify(result.output) }],
                isError: result.isError ?? false,
                timestamp: message.createdAt ?? 0,
            });
        }
        return results;
    }

    /* ------------------------- 工具转换：ToolSchema → pi Tool（TypeBox） ------------------------- */

    function toPiTool(schema: ToolSchema): Tool {
        return {
            name: sanitizeToolName(schema.name),
            description: schema.description,
            parameters: toTypeBoxSchema(schema.parameters ?? {}),
        };
    }

    /** JSON Schema 子集（object/string/number/integer/boolean/array + properties/required/items）→ TypeBox。 */
    function toTypeBoxSchema(schema: Record<string, unknown>): TSchema {
        const description =
            typeof schema.description === 'string' ? { description: schema.description } : {};
        switch (schema.type) {
            case 'string':
                return Type.String(description);
            case 'number':
                return Type.Number(description);
            case 'integer':
                return Type.Integer(description);
            case 'boolean':
                return Type.Boolean(description);
            case 'array': {
                const items = schema.items as Record<string, unknown> | undefined;
                return Type.Array(items ? toTypeBoxSchema(items) : Type.Unknown());
            }
            case 'object': {
                const properties = (schema.properties ?? {}) as Record<
                    string,
                    Record<string, unknown>
                >;
                const required = Array.isArray(schema.required)
                    ? schema.required.filter((key): key is string => typeof key === 'string')
                    : [];
                const props: Record<string, TSchema> = {};
                for (const [key, propSchema] of Object.entries(properties)) {
                    const boxed = toTypeBoxSchema(propSchema);
                    props[key] = required.includes(key) ? boxed : Type.Optional(boxed);
                }
                return Type.Object(props);
            }
            default:
                return Type.Unknown();
        }
    }

    /* ------------------------- 请求选项：LLMRequest → pi options ------------------------- */

    function toPiOptions(request: LLMRequest): ModelsApiStreamOptions<Api> {
        const opts: Record<string, unknown> = {};
        if (request.signal) opts.signal = request.signal;
        if (request.temperature !== undefined) opts.temperature = request.temperature;
        if (request.maxTokens !== undefined) opts.maxTokens = request.maxTokens;
        if (options.apiKey) opts.apiKey = options.apiKey;
        // 核采样 / 停止序列：pi 通过 samplingParams 透传请求体字段
        const sampling: Record<string, unknown> = {};
        if (request.topP !== undefined) sampling.top_p = request.topP;
        if (request.stop && request.stop.length > 0) sampling.stop = request.stop;
        if (Object.keys(sampling).length > 0) opts.samplingParams = sampling;
        // 厂商特有参数透传（如 reasoningEffort / thinkingBudgets），显式键优先
        if (request.extra) Object.assign(opts, request.extra);
        return opts as ModelsApiStreamOptions<Api>;
    }

    /* ------------------------- 用量转换：pi Usage → TokenUsage ------------------------- */

    /**
     * 语义（core TokenUsage，OpenAI 计数范式）：inputTokens = 全部输入（含缓存命中部分），
     * cachedInputTokens ⊆ inputTokens。pi-ai 的 cacheRead/cacheWrite 为独立细分字段；
     * 此处沿用保守映射：input/output 原样、cacheRead → cachedInputTokens、reasoning → reasoningTokens。
     * totalTokens 按 core 定义取 inputTokens + outputTokens。
     */
    function toUsage(usage: PiUsage): TokenUsage {
        const inputTokens = usage.input;
        const outputTokens = usage.output;
        const result: TokenUsage = {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
        };
        if (usage.cacheRead > 0) {
            result.cachedInputTokens = usage.cacheRead;
        }
        if (usage.reasoning !== undefined) {
            result.reasoningTokens = usage.reasoning;
        }
        return result;
    }

    /* ------------------------- 错误转换：pi 错误 → ProviderError ------------------------- */

    function toProviderErrorFromUnknown(error: unknown): ProviderError {
        if (error instanceof ProviderError) {
            return error;
        }
        if (error instanceof ModelsError) {
            if (error.code === 'auth' || error.code === 'oauth') {
                return new ProviderError('auth', error.message, { raw: error });
            }
            return toProviderError(error.message);
        }
        if (error instanceof Error) {
            return toProviderError(error.message);
        }
        return new ProviderError('unknown', String(error), { raw: error });
    }

    function toProviderError(message: string): ProviderError {
        if (/rate.?limit|429/i.test(message)) {
            return new ProviderError('rate_limit', message);
        }
        if (/context.?length|maximum context|tokens?/i.test(message)) {
            return new ProviderError('context_length_exceeded', message);
        }
        if (/unauthorized|not configured|api[ _-]?key|401|403/i.test(message)) {
            return new ProviderError('auth', message);
        }
        if (/timeout|ETIMEDOUT|aborted/i.test(message)) {
            return new ProviderError('timeout', message);
        }
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|network/i.test(message)) {
            return new ProviderError('network', message);
        }
        return new ProviderError('unknown', message);
    }
}

/* ------------------------- 内部工具 ------------------------- */

const ZERO_USAGE: PiAssistantMessage['usage'] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 从 pi-ai partial 消息按 contentIndex 取 toolCall 块（start/delta 阶段 id/name 就绪时返回）。 */
function toolCallAt(contentIndex: number, partial: PiAssistantMessage): PiToolCall | undefined {
    const block = partial.content[contentIndex];
    if (block !== undefined && block.type === 'toolCall' && block.id && block.name) {
        return block;
    }
    return undefined;
}

function stringify(output: unknown): string {
    if (typeof output === 'string') return output;
    if (Array.isArray(output)) {
        // ToolResult.output 可为 ContentBlock[]（如工具产图）；文本块拼接，其余 JSON 化
        const text = (output as ContentBlock[])
            .filter((block) => block.type === 'text')
            .map((block) => (block as TextBlock).text)
            .join('\n');
        if (text) return text;
    }
    return JSON.stringify(output);
}

function toSystemText(blocks: TextBlock[]): string {
    return blocks.map((block) => block.text).join('\n');
}

function toReasoningBlock(block: ThinkingContent): ReasoningBlock {
    return {
        type: 'reasoning',
        text: block.thinking,
        ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}),
    };
}

function toContentTypes(input: readonly string[]): ContentType[] {
    const types: ContentType[] = ['text'];
    if (input.includes('image')) types.push('image');
    return types;
}

function mapStopReason(reason: PiAssistantMessage['stopReason']): LLMFinishReason {
    switch (reason) {
        case 'toolUse':
            return 'tool_calls';
        case 'stop':
            return 'stop';
        case 'length':
            return 'length';
        case 'error':
            return 'other';
        default:
            return 'other'; // pending / aborted / deferred
    }
}

function mapDoneReason(reason: 'stop' | 'length' | 'toolUse' | 'deferred'): LLMFinishReason {
    switch (reason) {
        case 'toolUse':
            return 'tool_calls';
        case 'stop':
            return 'stop';
        case 'length':
            return 'length';
        default:
            return 'other';
    }
}
