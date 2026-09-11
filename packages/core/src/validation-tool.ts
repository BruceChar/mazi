import {
    type ContentBlock,
    type ContentType,
    type LLMMessage,
    type LLMProvider,
    type LLMRequest,
    ProviderError,
    type ProviderModel,
    type StreamCompletionEvent,
    type TextBlock,
    type ToolCall,
    type ToolChoice,
    type ToolResult,
    type ToolSchema,
} from './provider.js';

// ============================================================
// 10. 校验:内容块
// ============================================================

const ALL_BLOCK_TYPES: ReadonlySet<string> = new Set([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'spreadsheet',
    'code',
    'reasoning',
]);

/** §3.1 合法位置矩阵:system 仅 text */
const SYSTEM_BLOCK_TYPES: ReadonlySet<string> = new Set(['text']);
/** user:除 reasoning 外全部 */
const USER_BLOCK_TYPES: ReadonlySet<string> = new Set([
    'text',
    'image',
    'audio',
    'video',
    'document',
    'spreadsheet',
    'code',
]);
/** assistant:模型输出历史,不过度限制(含 reasoning;未来多模态输出) */
const ASSISTANT_BLOCK_TYPES: ReadonlySet<string> = ALL_BLOCK_TYPES;
/** tool 结果:text + image(§3.1:image 合法位置含 tool 结果) */
const TOOL_RESULT_BLOCK_TYPES: ReadonlySet<string> = new Set(['text', 'image']);

const URL_PATTERN = /^https?:\/\//i;
const DATA_URI_PATTERN = /^data:[^,;]+\/[^,;]+;base64,/i;

/** 内部:契约违规的快捷工厂 */
function invalidRequest(message: string): ProviderError {
    return new ProviderError('invalid_request', message);
}

function validateDataReference(data: unknown, path: string): void {
    if (typeof data !== 'string' || data.length === 0) {
        throw invalidRequest(`${path}: must be a non-empty string`);
    }
    if (!URL_PATTERN.test(data) && !DATA_URI_PATTERN.test(data)) {
        throw invalidRequest(
            `${path}: must be an http(s) URL or a base64 data URI (data:<mime>;base64,<payload>); ` +
                `bare base64 is a contract violation [CORE §3.2]`,
        );
    }
}

function validateBlockShape(block: ContentBlock, allowed: ReadonlySet<string>, path: string): void {
    if (block === null || typeof block !== 'object') {
        throw invalidRequest(`${path}: block must be an object`);
    }
    const type = (block as { type?: unknown }).type;
    if (typeof type !== 'string' || !ALL_BLOCK_TYPES.has(type)) {
        throw invalidRequest(`${path}: unknown block type ${JSON.stringify(type)}`);
    }
    if (!allowed.has(type)) {
        throw invalidRequest(
            `${path}: block type "${type}" is not allowed in this position [CORE §3.1]`,
        );
    }
    switch (type) {
        case 'text':
        case 'reasoning': {
            const text = (block as { text?: unknown }).text;
            if (typeof text !== 'string') {
                throw invalidRequest(`${path}.text: must be a string`);
            }
            break;
        }
        default: {
            validateDataReference((block as { data?: unknown }).data, `${path}.data`);
            break;
        }
    }
}

function validateBlockList(
    blocks: ContentBlock[],
    allowed: ReadonlySet<string>,
    path: string,
): void {
    if (!Array.isArray(blocks)) {
        throw invalidRequest(`${path}: must be an array of content blocks`);
    }
    blocks.forEach((block, i) => {
        validateBlockShape(block, allowed, `${path}[${i}]`);
    });
}

// ============================================================
// 11. 校验:消息与 TOOL-PAIR [CORE §4]
// ============================================================

/**
 * 消息级契约校验(构造层主责,Provider 请求层兜底复用):
 * 前缀区 system、reasoning 位置、空消息、TOOL-PAIR 成对性、callId 唯一性。
 */
export function validateMessages(messages: LLMMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw invalidRequest('LLMRequest.messages must be a non-empty array [CORE §6.1]');
    }

    let sawNonSystem = false;

    messages.forEach((message, index) => {
        const where = `messages[${index}]`;
        if (message === null || typeof message !== 'object') {
            throw invalidRequest(`${where}: message must be an object`);
        }

        switch (message.role) {
            case 'system': {
                if (sawNonSystem) {
                    throw invalidRequest(
                        `${where}: SystemMessage is only legal in the prefix region ` +
                            `(before the first non-system message) [CORE §4.2]`,
                    );
                }
                validateBlockList(message.content, SYSTEM_BLOCK_TYPES, `${where}.content`);
                if (message.content.length === 0) {
                    throw invalidRequest(`${where}: empty message`);
                }
                break;
            }
            case 'user': {
                sawNonSystem = true;
                validateBlockList(message.content, USER_BLOCK_TYPES, `${where}.content`);
                if (message.content.length === 0) {
                    throw invalidRequest(`${where}: empty message [CORE §4.4]`);
                }
                break;
            }
            case 'assistant': {
                sawNonSystem = true;
                validateBlockList(message.content, ASSISTANT_BLOCK_TYPES, `${where}.content`);
                const hasToolCalls =
                    message.toolCalls !== undefined && message.toolCalls.length > 0;
                if (message.content.length === 0 && !hasToolCalls) {
                    throw invalidRequest(
                        `${where}: empty message (content and toolCalls are both empty) [CORE §4.4]`,
                    );
                }
                if (message.toolCalls !== undefined) {
                    validateToolCallList(message.toolCalls, `${where}.toolCalls`);
                }
                break;
            }
            case 'tool': {
                sawNonSystem = true;
                if (!Array.isArray(message.results) || message.results.length === 0) {
                    throw invalidRequest(`${where}.results: must be a non-empty array [CORE §4.1]`);
                }
                message.results.forEach((result, rIndex) => {
                    validateToolResult(result, `${where}.results[${rIndex}]`);
                });
                break;
            }
            default:
                throw invalidRequest(
                    `${where}: unknown role ${JSON.stringify((message as { role?: unknown }).role)}`,
                );
        }
    });

    validateToolPairing(messages);
}

function validateToolCallList(toolCalls: ToolCall[], path: string): void {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw invalidRequest(`${path}: must be a non-empty array when present`);
    }
    toolCalls.forEach((call, i) => {
        const p = `${path}[${i}]`;
        if (typeof call.callId !== 'string' || call.callId.length === 0) {
            throw invalidRequest(`${p}.callId: must be a non-empty string`);
        }
        if (typeof call.name !== 'string' || call.name.length === 0) {
            throw invalidRequest(`${p}.name: must be a non-empty string`);
        }
        if (
            call.arguments === null ||
            typeof call.arguments !== 'object' ||
            Array.isArray(call.arguments)
        ) {
            throw invalidRequest(`${p}.arguments: must be a JSON object`);
        }
    });
}

function validateToolResult(result: ToolResult, path: string): void {
    if (typeof result.callId !== 'string' || result.callId.length === 0) {
        throw invalidRequest(`${path}.callId: must be a non-empty string`);
    }
    if (result.isError !== undefined && typeof result.isError !== 'boolean') {
        throw invalidRequest(`${path}.isError: must be a boolean when present`);
    }
    if (typeof result.output === 'string') {
        return; // 空字符串允许(工具可无输出)
    }
    if (Array.isArray(result.output)) {
        if (result.output.length === 0) {
            throw invalidRequest(`${path}.output: block array must be non-empty`);
        }
        validateBlockList(result.output, TOOL_RESULT_BLOCK_TYPES, `${path}.output`);
        return;
    }
    throw invalidRequest(`${path}.output: must be a string or ContentBlock[] [CORE §5.1]`);
}

/** TOOL-PAIR 成对不变量:意图与结果按全对话顺序配对,callId 全局唯一 */
function validateToolPairing(messages: LLMMessage[]): void {
    const declared = new Set<string>();
    const matched = new Set<string>();

    messages.forEach((message, index) => {
        if (message.role === 'assistant' && message.toolCalls !== undefined) {
            for (const call of message.toolCalls) {
                if (declared.has(call.callId)) {
                    throw invalidRequest(
                        `messages[${index}]: duplicate toolCall callId "${call.callId}" [CORE §4.3]`,
                    );
                }
                declared.add(call.callId);
            }
        } else if (message.role === 'tool') {
            for (const result of message.results) {
                if (!declared.has(result.callId)) {
                    throw invalidRequest(
                        `messages[${index}]: tool result "${result.callId}" has no preceding ` +
                            `assistant toolCall [CORE §4.3 TOOL-PAIR]`,
                    );
                }
                if (matched.has(result.callId)) {
                    throw invalidRequest(
                        `messages[${index}]: duplicate tool result for callId "${result.callId}" [CORE §4.3]`,
                    );
                }
                matched.add(result.callId);
            }
        }
    });

    for (const callId of declared) {
        if (!matched.has(callId)) {
            throw invalidRequest(
                `toolCall "${callId}" has no matching tool result; ` +
                    `complete tool results before sending the conversation [CORE §4.3 TOOL-PAIR]`,
            );
        }
    }
}

// ============================================================
// 12. 校验:工具 schema [CORE §5.2]
// ============================================================

export function validateToolSchema(schema: ToolSchema, path = 'tool'): void {
    if (schema === null || typeof schema !== 'object') {
        throw invalidRequest(`${path}: ToolSchema must be an object`);
    }
    if (typeof schema.name !== 'string' || schema.name.length === 0) {
        throw invalidRequest(`${path}.name: must be a non-empty string`);
    }
    if (typeof schema.description !== 'string') {
        throw invalidRequest(`${path}.description: must be a string`);
    }
    if (schema.parameters !== undefined) {
        if (
            schema.parameters === null ||
            typeof schema.parameters !== 'object' ||
            Array.isArray(schema.parameters)
        ) {
            throw invalidRequest(`${path}.parameters: must be a JSON Schema object`);
        }
        validateObjectSchemaRoot(schema.parameters, `${path}.parameters`);
        validateSchemaConstraints(schema.parameters, `${path}.parameters`);
    }
}

function validateObjectSchemaRoot(node: Record<string, unknown>, path: string): void {
    const type = node.type;
    const hasProperties = node.properties !== undefined;
    if (type !== 'object' && !hasProperties) {
        throw invalidRequest(
            `${path}: root must be an object schema (type:"object" or "properties" present) [CORE §5.2]`,
        );
    }
    const required = node.required;
    if (required === undefined) return;
    if (!Array.isArray(required)) {
        throw invalidRequest(`${path}.required: must be an array of strings`);
    }
    const properties = node.properties;
    const propertiesRecord =
        properties !== undefined && typeof properties === 'object' && !Array.isArray(properties)
            ? (properties as Record<string, unknown>)
            : undefined;
    for (const key of required) {
        if (typeof key !== 'string') {
            throw invalidRequest(`${path}.required: entries must be strings`);
        }
        if (propertiesRecord === undefined || !(key in propertiesRecord)) {
            throw invalidRequest(
                `${path}: required key "${key}" is not declared in properties [CORE §5.2]`,
            );
        }
    }
}

/**
 * 递归校验约束-类型匹配(§5.2):
 * minLength/maxLength/pattern 仅 string;minimum/maximum 仅 number/integer;items 仅 array。
 * type 未声明时跳过约束检查(厂商口径依赖,宽松处理);未知关键字透传不校验。
 */
function validateSchemaConstraints(node: unknown, path: string): void {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const schema = node as Record<string, unknown>;
    const type = schema.type;

    if (typeof type === 'string') {
        if (type !== 'string') {
            for (const key of ['minLength', 'maxLength', 'pattern'] as const) {
                if (schema[key] !== undefined) {
                    throw invalidRequest(
                        `${path}: "${key}" is only valid for type "string", got "${type}" [CORE §5.2]`,
                    );
                }
            }
        }
        if (type !== 'number' && type !== 'integer') {
            for (const key of ['minimum', 'maximum'] as const) {
                if (schema[key] !== undefined) {
                    throw invalidRequest(
                        `${path}: "${key}" is only valid for type "number"/"integer", got "${type}" [CORE §5.2]`,
                    );
                }
            }
        }
        if (type !== 'array' && schema.items !== undefined) {
            throw invalidRequest(
                `${path}: "items" is only valid for type "array", got "${type}" [CORE §5.2]`,
            );
        }
    }

    const properties = schema.properties;
    if (properties !== undefined && typeof properties === 'object' && !Array.isArray(properties)) {
        const props = properties as Record<string, unknown>;
        for (const [key, child] of Object.entries(props)) {
            validateSchemaConstraints(child, `${path}.properties.${key}`);
        }
    }
    const items = schema.items;
    if (items !== undefined) {
        validateSchemaConstraints(items, `${path}.items`);
    }
}

// ============================================================
// 13. 校验:请求形状 [CORE §6]
// ============================================================

/** 契约层请求形状校验(不涉及能力);消息/工具校验包含在内 */
export function validateRequestShape(request: LLMRequest): void {
    if (request === null || typeof request !== 'object') {
        throw invalidRequest('LLMRequest must be an object');
    }

    if (
        request.model !== undefined &&
        (typeof request.model !== 'string' || request.model.length === 0)
    ) {
        throw invalidRequest('LLMRequest.model: must be a non-empty string when present');
    }

    if (request.system !== undefined) {
        if (typeof request.system === 'string') {
            // 空字符串 = 无系统提示,允许
        } else if (Array.isArray(request.system)) {
            request.system.forEach((block, i) => {
                validateBlockShape(block, SYSTEM_BLOCK_TYPES, `request.system[${i}]`);
            });
        } else {
            throw invalidRequest('LLMRequest.system: must be a string or TextBlock[] [CORE §4.2]');
        }
    }

    validateMessages(request.messages);

    if (request.tools !== undefined) {
        if (!Array.isArray(request.tools) || request.tools.length === 0) {
            throw invalidRequest(
                'LLMRequest.tools: must be a non-empty array when present (omit for pure conversation)',
            );
        }
        request.tools.forEach((tool, i) => {
            validateToolSchema(tool, `tools[${i}]`);
        });
    }

    if (request.toolChoice !== undefined) {
        validateToolChoice(request.toolChoice, request.tools);
    }

    if (request.temperature !== undefined) {
        const t = request.temperature;
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 2) {
            throw invalidRequest('LLMRequest.temperature: must be a finite number in [0, 2]');
        }
    }

    if (request.topP !== undefined) {
        const p = request.topP;
        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
            throw invalidRequest('LLMRequest.topP: must be a finite number in [0, 1]');
        }
    }

    if (request.maxTokens !== undefined) {
        const m = request.maxTokens;
        if (typeof m !== 'number' || !Number.isInteger(m) || m <= 0) {
            throw invalidRequest('LLMRequest.maxTokens: must be a positive integer');
        }
    }

    if (request.stop !== undefined) {
        if (!Array.isArray(request.stop)) {
            throw invalidRequest('LLMRequest.stop: must be an array of strings');
        }
        request.stop.forEach((s, i) => {
            if (typeof s !== 'string' || s.length === 0) {
                throw invalidRequest(`LLMRequest.stop[${i}]: must be a non-empty string`);
            }
        });
    }

    if (request.responseFormat !== undefined) {
        const rf = request.responseFormat;
        if (rf === null || typeof rf !== 'object') {
            throw invalidRequest('LLMRequest.responseFormat: must be an object');
        }
        if (rf.type !== 'json_object' && rf.type !== 'json_schema') {
            throw invalidRequest(
                'LLMRequest.responseFormat.type: must be "json_object" or "json_schema"',
            );
        }
        if (rf.type === 'json_schema') {
            if (rf.schema === undefined) {
                throw invalidRequest(
                    'LLMRequest.responseFormat: schema is required when type is "json_schema" [CORE §6.1]',
                );
            }
            validateObjectSchemaRoot(rf.schema, 'responseFormat.schema');
            validateSchemaConstraints(rf.schema, 'responseFormat.schema');
        }
    }

    if (request.thinking !== undefined) {
        const b = request.thinking.budgetTokens;
        if (b !== undefined && (typeof b !== 'number' || !Number.isInteger(b) || b <= 0)) {
            throw invalidRequest(
                'LLMRequest.thinking.budgetTokens: must be a positive integer when present',
            );
        }
    }

    if (request.extra !== undefined) {
        if (
            request.extra === null ||
            typeof request.extra !== 'object' ||
            Array.isArray(request.extra)
        ) {
            throw invalidRequest('LLMRequest.extra: must be a plain object');
        }
    }
}

function validateToolChoice(choice: ToolChoice, tools: ToolSchema[] | undefined): void {
    if (typeof choice === 'string') {
        if (choice !== 'auto' && choice !== 'none' && choice !== 'required') {
            throw invalidRequest(`LLMRequest.toolChoice: unknown value "${choice}"`);
        }
        if (choice === 'required' && (tools === undefined || tools.length === 0)) {
            throw invalidRequest(
                'LLMRequest.toolChoice "required" requires a non-empty tools list',
            );
        }
        return;
    }
    if (choice !== null && typeof choice === 'object') {
        const name = (choice as { name?: unknown }).name;
        if (typeof name !== 'string' || name.length === 0) {
            throw invalidRequest('LLMRequest.toolChoice: {name} must carry a non-empty name');
        }
        if (tools === undefined || !tools.some((tool) => tool.name === name)) {
            throw invalidRequest(
                `LLMRequest.toolChoice: name "${name}" is not present in request.tools`,
            );
        }
        return;
    }
    throw invalidRequest('LLMRequest.toolChoice: must be "auto" | "none" | "required" | {name}');
}

// ============================================================
// 14. 校验:能力协商 + 共享入口 [CORE §10.2 / §9.2]
// ============================================================

/** §3.3 可文本化降级的块类型(Adapter 转换为 TextBlock 并记录诊断) */
const TEXT_DEGRADABLE_TYPES: ReadonlySet<ContentType> = new Set([
    'document',
    'spreadsheet',
    'code',
]);

function isForcedToolChoice(choice: ToolChoice | undefined): boolean {
    return choice === 'required' || (typeof choice === 'object' && choice !== null);
}

function checkInputBlockType(
    block: ContentBlock,
    inputTypes: ContentType[],
    modelId: string,
    path: string,
): void {
    if (block.type === 'text') return;
    // reasoning 为 assistant 历史回传,厂商适配职责(§5.4),不参与输入类型协商
    if (block.type === 'reasoning') return;
    if (inputTypes.includes(block.type)) return;
    if (TEXT_DEGRADABLE_TYPES.has(block.type)) return; // §3.3 降级路径
    throw invalidRequest(
        `${path}: content type "${block.type}" is not accepted by model "${modelId}" ` +
            `(inputTypes: [${inputTypes.join(', ')}]) and has no degradation path [CORE §3.3/§10.2]`,
    );
}

/** 请求期能力协商(§10.2 表逐行);两入口必须共用 */
export function validateRequestAgainstCapabilities(
    request: LLMRequest,
    model: ProviderModel,
): void {
    const caps = model.capabilities;

    if (request.tools !== undefined && request.tools.length > 0 && !caps.supportsToolCalls) {
        throw invalidRequest(`model "${model.id}" does not support tool calls [CORE §10.2]`);
    }

    if (isForcedToolChoice(request.toolChoice) && caps.supportsForcedToolChoice !== true) {
        throw invalidRequest(
            `model "${model.id}" does not support forced tool choice [CORE §10.2]`,
        );
    }

    if (request.responseFormat !== undefined && caps.supportsStructuredOutput !== true) {
        throw invalidRequest(`model "${model.id}" does not support structured output [CORE §10.2]`);
    }

    if (request.thinking !== undefined && caps.supportsReasoning !== true) {
        throw invalidRequest(
            `model "${model.id}" does not support reasoning/thinking [CORE §10.2]`,
        );
    }

    const inputTypes = caps.inputTypes;
    request.messages.forEach((message, mIndex) => {
        if (message.role === 'tool') {
            message.results.forEach((result, rIndex) => {
                if (Array.isArray(result.output)) {
                    result.output.forEach((block, bIndex) => {
                        checkInputBlockType(
                            block,
                            inputTypes,
                            model.id,
                            `messages[${mIndex}].results[${rIndex}].output[${bIndex}]`,
                        );
                    });
                }
            });
        } else {
            message.content.forEach((block, bIndex) => {
                checkInputBlockType(
                    block,
                    inputTypes,
                    model.id,
                    `messages[${mIndex}].content[${bIndex}]`,
                );
            });
        }
    });

    if (
        request.maxTokens !== undefined &&
        caps.maxOutputTokens !== undefined &&
        request.maxTokens > caps.maxOutputTokens
    ) {
        throw invalidRequest(
            `LLMRequest.maxTokens=${request.maxTokens} exceeds model "${model.id}" ` +
                `maxOutputTokens=${caps.maxOutputTokens} [CORE §10.2]`,
        );
    }
}

/** 模型解析:request.model → provider.models;两者皆缺或不存在 → invalid_request */
export function resolveModel(
    provider: Pick<LLMProvider, 'models' | 'defaultModel'>,
    requestedModel?: string,
): ProviderModel {
    const id = requestedModel ?? provider.defaultModel;
    if (id === undefined || id.length === 0) {
        throw invalidRequest(
            'LLMRequest.model is required (no provider defaultModel configured) [CORE §10.2]',
        );
    }
    const model = provider.models.find((m) => m.id === id);
    if (model === undefined) {
        throw invalidRequest(`unknown model "${id}"; it is not in provider.models [CORE §10.2]`);
    }
    return model;
}

/**
 * 两入口共享校验入口(EQUIV,§9.2):
 * ask 与 askStream 实现必须在发起网络调用前调用本函数(顺序:形状 → 模型解析 → 能力协商),
 * 返回解析后的 ProviderModel 供 wire 层映射使用。
 */
export function validateLLMRequest(
    request: LLMRequest,
    provider: Pick<LLMProvider, 'models' | 'defaultModel'>,
): ProviderModel {
    validateRequestShape(request);
    const model = resolveModel(provider, request.model);
    validateRequestAgainstCapabilities(request, model);
    return model;
}

// ============================================================
// 15. SYSTEM-NORM 归一化 [CORE §4.2]
// ============================================================

/**
 * 归一化算法(SYSTEM-NORM):
 * 顶层 request.system 在前(字符串展开为单 TextBlock)→ messages 前缀区 SystemMessage 在后。
 * 前缀区 = 首条非 system 消息之前的区域;非前缀区 system 由 validateMessages 拒绝。
 * 前置条件:先调用 validateMessages / validateRequestShape。
 */
export function normalizeSystemPrompt(
    request: Pick<LLMRequest, 'system' | 'messages'>,
): TextBlock[] {
    const blocks: TextBlock[] = [];
    if (typeof request.system === 'string') {
        blocks.push({ type: 'text', text: request.system });
    } else if (Array.isArray(request.system)) {
        blocks.push(...request.system);
    }
    for (const message of request.messages) {
        if (message.role !== 'system') break;
        blocks.push(...message.content);
    }
    return blocks;
}

/**
 * 块序列 → 单字符串(映射到"顶层单字符串 system"型厂商,如 OpenAI 系)。
 * 以 "\n\n" 连接是规范行为(§4.2 Adapter 映射规则),写入测试。
 * 空序列返回 undefined(无系统提示)。
 */
export function joinSystemPrompt(blocks: TextBlock[]): string | undefined {
    if (blocks.length === 0) return undefined;
    return blocks.map((block) => block.text).join('\n\n');
}

// ============================================================
// 16. 事件序列不变量断言器 [CORE §7.2]
// ============================================================

/**
 * 流式事件序列断言器(供测试与消费方断言 §7.2 不变量):
 * - start 恰一次且为首事件;finish 恰一次且为末事件;
 * - text/reasoning delta 任意交错;
 * - 同 index 工具事件满足 start → delta* → stop,不同 index 可交错;
 * - usage 恰一次且先于 finish;
 * - 违规抛 ProviderError('invalid_request')(视为上游 Adapter bug,快速暴露)。
 */
export class EventSequenceValidator {
    private started = false;
    private finished = false;
    private usageCount = 0;
    private readonly openSlots = new Map<number, string>(); // index → callId
    private readonly closedSlots = new Set<number>();

    next(event: StreamCompletionEvent): void {
        if (this.finished) {
            throw invalidRequest(
                `event "${event.type}" arrives after "finish"; finish must be the last event [CORE §7.2]`,
            );
        }
        if (!this.started) {
            if (event.type !== 'start') {
                throw invalidRequest(
                    `the first stream event must be "start", got "${event.type}" [CORE §7.2]`,
                );
            }
            this.started = true;
            return;
        }
        switch (event.type) {
            case 'start':
                throw invalidRequest('duplicate "start" event [CORE §7.2]');
            case 'text_delta':
            case 'reasoning_delta':
                return;
            case 'tool_call_start':
                if (this.openSlots.has(event.index) || this.closedSlots.has(event.index)) {
                    throw invalidRequest(
                        `tool_call_start: index ${event.index} is already open or closed [CORE §7.2]`,
                    );
                }
                this.openSlots.set(event.index, event.callId);
                return;
            case 'tool_call_delta':
                if (!this.openSlots.has(event.index)) {
                    throw invalidRequest(
                        `tool_call_delta: index ${event.index} is not an open tool call slot [CORE §7.2]`,
                    );
                }
                return;
            case 'tool_call_stop':
                if (!this.openSlots.has(event.index)) {
                    throw invalidRequest(
                        `tool_call_stop: index ${event.index} is not an open tool call slot [CORE §7.2]`,
                    );
                }
                this.openSlots.delete(event.index);
                this.closedSlots.add(event.index);
                return;
            case 'usage':
                this.usageCount += 1;
                if (this.usageCount > 1) {
                    throw invalidRequest(
                        'duplicate "usage" event; exactly one is allowed before "finish" [CORE §7.2]',
                    );
                }
                return;
            case 'finish':
                if (this.openSlots.size > 0) {
                    throw invalidRequest(
                        `"finish" arrives with unclosed tool call slot(s): ` +
                            `[${[...this.openSlots.keys()].join(', ')}] [CORE §7.2]`,
                    );
                }
                this.finished = true;
                return;
        }
    }

    /** 流正常结束时调用:断言 start/finish 恰一次、usage 恰一次 */
    assertComplete(): void {
        if (!this.started) {
            throw invalidRequest('stream ended without a "start" event [CORE §7.2]');
        }
        if (!this.finished) {
            throw invalidRequest('stream ended without a "finish" event [CORE §7.2]');
        }
        if (this.usageCount !== 1) {
            throw invalidRequest(
                'a successful stream must contain exactly one "usage" event [CORE §7.2]',
            );
        }
    }
}

/** 便利函数:对完整事件数组断言 §7.2 不变量 */
export function assertEventSequence(events: Iterable<StreamCompletionEvent>): void {
    const validator = new EventSequenceValidator();
    for (const event of events) {
        validator.next(event);
    }
    validator.assertComplete();
}
