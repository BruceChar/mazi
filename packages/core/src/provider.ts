/**
 * provider —— LLM Provider 契约的唯一实现载体（PROVIDER-CORE 契约，文件名按
 * AHF_CORE_PROVIDER 约定为 provider.ts；provider-core.ts 已被本文件取代）
 *
 * 设计规范: docs/core/AHF_CORE_PROVIDER.md (PROVIDER-CORE v1.0)
 * 实现与文档不一致时,以文档为准并修正本文件。
 *
 * 分层边界(防腐):
 * - 本文件承载:厂商无关的通信核心语义(内容块 / 消息 / 工具 / 请求 / 事件 /
 *   usage / 响应 / 能力 / 错误)及其校验与归一化函数;
 * - 不承载:重试/failover 判断、计价、画像、健康度、限流、超时编排(归 provider-runtime);
 * - 零外部运行时依赖;不导入任何厂商 SDK 类型;
 * - ProviderError 不含 retryable —— 策略判断在 runtime。
 *
 * 导出约定:index.ts 仅 re-export 本文件;内部实现细节一律不导出。
 */

// ============================================================
// 1. 错误体系
// ============================================================

/** 厂商失败事件的归一语义(事实);不含任何策略判断 */
export type ProviderErrorCode =
    | 'rate_limit'
    | 'context_length_exceeded'
    | 'auth'
    | 'timeout'
    | 'network'
    | 'invalid_request'
    | 'provider_unavailable'
    | 'aborted'
    | 'unknown';

export class ProviderError extends Error {
    /** 厂商失败事件的归一语义 */
    readonly code: ProviderErrorCode;
    /** 限流时从厂商响应头解析的退避提示(厂商披露值,非策略决定) */
    readonly retryAfterMs?: number;
    /** 厂商原文/原始异常,仅诊断用途 */
    readonly raw?: unknown;

    constructor(
        code: ProviderErrorCode,
        message: string,
        options: { retryAfterMs?: number; raw?: unknown } = {},
    ) {
        super(message);
        this.name = 'ProviderError';
        this.code = code;
        this.retryAfterMs = options.retryAfterMs;
        this.raw = options.raw;
    }
}

/** 厂商原始错误 → ProviderError 的纯映射函数,由各 Adapter 提供 */
export type MapProviderError = (error: unknown, request: LLMRequest) => ProviderError;

// ============================================================
// 2. 内容类型与内容块 [CORE §3]
// ============================================================

export type ContentType =
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'document' // PDF、DOCX、TXT、MD
    | 'spreadsheet' // CSV、XLSX
    | 'code'; // 代码文件

export interface TextBlock {
    type: 'text';
    text: string;
}

export interface ImageBlock {
    type: 'image';
    /** 必须为 URL(http/https)或 data URI(data:<mime>;base64,<payload>);禁止裸 base64 */
    data: string;
    /** URL 时可省略;data URI 内嵌 mime,此字段仅为冗余校验 */
    mimeType?: string;
}

export interface AudioBlock {
    type: 'audio';
    data: string; // 同 ImageBlock 规范
    mimeType?: string;
}

export interface VideoBlock {
    type: 'video';
    data: string; // 同上
    mimeType?: string;
}

export interface DocumentBlock {
    type: 'document';
    data: string;
    name?: string;
    mimeType?: string;
}

export interface SpreadsheetBlock {
    type: 'spreadsheet';
    data: string;
    name?: string;
    mimeType?: string;
}

export interface CodeBlock {
    type: 'code';
    data: string;
    language?: string;
}

/** 推理/思考过程 — 仅合法于 assistant 消息(§3.1/§4.4) */
export interface ReasoningBlock {
    type: 'reasoning';
    text: string;
    /** Anthropic extended thinking 签名;回传历史时 Adapter 按厂商规则使用(§5.4) */
    signature?: string;
}

export type ContentBlock =
    | TextBlock
    | ImageBlock
    | AudioBlock
    | VideoBlock
    | DocumentBlock
    | SpreadsheetBlock
    | CodeBlock
    | ReasoningBlock;

// ============================================================
// 3. 消息模型 [CORE §4]
// ============================================================

interface MessageBase {
    /** 会话层行李:无 wire 语义,Provider 实现禁止读取依赖 */
    id?: string;
    createdAt?: number;
    metadata?: Record<string, unknown>;
}

export interface SystemMessage extends MessageBase {
    role: 'system';
    content: TextBlock[];
}

export interface UserMessage extends MessageBase {
    role: 'user';
    content: ContentBlock[];
}

export interface AssistantMessage extends MessageBase {
    role: 'assistant';
    /** 内容块(text / reasoning / image 等) */
    content: ContentBlock[];
    /** 工具调用意图 — 独立一等字段,不混入 content */
    toolCalls?: ToolCall[];
    name?: string;
}

export interface ToolMessage extends MessageBase {
    role: 'tool';
    /** 一条消息可承载多个并行工具调用的结果 */
    results: ToolResult[];
    name?: string;
}

export type LLMMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ============================================================
// 4. 工具协议 [CORE §5]
// ============================================================

export interface ToolCall {
    /** 唯一调用标识(与 ToolResult.callId 配对) */
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface ToolResult {
    callId: string;
    /** 工具输出:string 直传;结构化输出以 ContentBlock[] 表达(如工具产图) */
    output: string | ContentBlock[];
    /** 一等字段。禁止以 '[error] ' 前缀编码错误 */
    isError?: boolean;
}

export interface ToolSchema {
    name: string;
    description: string;
    /** JSON Schema 对象;存在时必须为 object schema(§5.2 校验) */
    parameters?: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

// ============================================================
// 5. 请求契约 [CORE §6]
// ============================================================

/** 系统提示:简写形态(单字符串)或多段文本块(保真形态)(§4.2 双入口) */
export type SystemPrompt = string | TextBlock[];

export interface ThinkingConfig {
    /** 思考预算(Anthropic 语义);厂商无对应概念时由 Adapter 映射到近似档位或拒绝 */
    budgetTokens?: number;
}

export interface StructuredOutputRequest {
    type: 'json_object' | 'json_schema';
    /** type='json_schema' 时必填 */
    schema?: Record<string, unknown>;
}

export interface LLMRequest {
    /** 目标模型(ProviderModel.id);缺省时使用 provider.defaultModel */
    model?: string;
    /** 系统提示(主入口);与 messages 前缀区 SystemMessage 合并归一(SYSTEM-NORM) */
    system?: SystemPrompt;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    toolChoice?: ToolChoice;
    temperature?: number;
    topP?: number;
    /** 输出 token 上限;超过 capabilities.maxOutputTokens → invalid_request */
    maxTokens?: number;
    stop?: string[];
    /** 响应格式;模型不支持 → invalid_request(不静默忽略) */
    responseFormat?: StructuredOutputRequest;
    /** 开启推理/思考;模型不支持 → invalid_request */
    thinking?: ThinkingConfig;
    /** 取消信号;触发后 Provider 抛 ProviderError('aborted')。超时定时器由 runtime 合成 */
    signal?: AbortSignal;
    /** 厂商特有参数逃生舱(透传守则见 [CORE §6.2]) */
    extra?: Record<string, unknown>;
    // 注意:不设 stream 字段 —— 流式与否由调用方法决定,避免双真相源
}

// ============================================================
// 6. Token Usage [CORE §8](对齐 OpenAI 范式)
// ============================================================

/**
 * Usage 语义以 OpenAI 计数范式为规范基线:
 * inputTokens / outputTokens 是总量第一字段;缓存与推理为正交细分维度。
 *
 *   inputTokens  = 全部输入(含缓存命中部分);cachedInputTokens ⊆ inputTokens
 *   outputTokens = 全部输出(含推理部分);   reasoningTokens  ⊆ outputTokens
 *
 * 字段 undefined = 厂商未报告(语义上不等于 0;计费层按 0 处理)。
 */
export interface TokenUsage {
    /** 全部输入 token(含缓存命中部分) */
    inputTokens?: number;
    /** 全部输出 token(含推理 token) */
    outputTokens?: number;
    /** inputTokens 的子集:缓存命中的输入部分 */
    cachedInputTokens?: number;
    /** outputTokens 的子集:模型推理/思考部分 */
    reasoningTokens?: number;
    /** inputTokens + outputTokens */
    totalTokens: number;
}

// ============================================================
// 7. 流式事件 [CORE §7]
// ============================================================

export interface StartEvent {
    type: 'start';
    /** 厂商响应 id(可得则填) */
    responseId?: string;
    model?: string;
}

export interface TextDeltaEvent {
    type: 'text_delta';
    text: string;
}

export interface ReasoningDeltaEvent {
    type: 'reasoning_delta';
    reasoning: string;
}

export interface ToolCallStartEvent {
    type: 'tool_call_start';
    /** 并行工具调用的槽位索引,Adapter 从厂商流中提取或自行编号 */
    index: number;
    callId: string;
    name: string;
}

export interface ToolCallDeltaEvent {
    type: 'tool_call_delta';
    index: number;
    /** arguments 的 JSON 文本片段(增量拼接) */
    argumentsDelta: string;
}

export interface ToolCallStopEvent {
    type: 'tool_call_stop';
    index: number;
}

export interface UsageEvent {
    type: 'usage';
    usage: TokenUsage;
}

export interface FinishEvent {
    type: 'finish';
    finishReason: LLMFinishReason;
    /** 归一前的厂商原文,仅诊断用途 */
    rawFinishReason?: string;
}

export type StreamCompletionEvent =
    | StartEvent
    | TextDeltaEvent
    | ReasoningDeltaEvent
    | ToolCallStartEvent
    | ToolCallDeltaEvent
    | ToolCallStopEvent
    | UsageEvent
    | FinishEvent;

// ============================================================
// 8. 响应契约 [CORE §9]
// ============================================================

export type LLMFinishReason =
    | 'stop'
    | 'tool_calls'
    | 'length'
    | 'content_filter'
    | 'insufficient_system_resource' // DeepSeek 服务端资源不足
    | 'other'; // 兜底:未知厂商值,rawFinishReason 保留原文

export interface LLMResponse {
    /** 厂商响应 id;未提供则缺省 */
    id?: string;
    model: string;
    /** 内容块(text / reasoning,按厂商输出顺序) */
    content: ContentBlock[];
    /** 工具调用(如有);arguments 必须是已解析的对象(§9.1) */
    toolCalls?: ToolCall[];
    usage?: TokenUsage;
    finishReason: LLMFinishReason;
    rawFinishReason?: string;
}

// ============================================================
// 9. Provider 接口与能力声明 [CORE §10]
// ============================================================

export interface ProviderCapabilities {
    supportsToolCalls: boolean;
    /** false = Adapter 以厂商非流式端点合成事件流(对调用方透明) */
    supportsStreaming: boolean;
    supportsStructuredOutput?: boolean;
    supportsReasoning?: boolean;
    /** 是否支持 forced tool choice(required / {name}) */
    supportsForcedToolChoice?: boolean;
    /** 上下文输入上限(token);请求侧静态可校验的部分 */
    maxInputTokens?: number;
    maxOutputTokens?: number;
    inputTypes: ContentType[];
    outputTypes: ContentType[];
}

export interface ProviderModel {
    /** 模型在池内的标识(LLMRequest.model 引用此值,非厂商裸名) */
    id: string;
    name: string;
    capabilities: ProviderCapabilities;
    vendor?: string;
}

/** 模型平台价格(USD / 百万 token;缺省 = 厂商未披露) */
export interface ProviderModelPricing {
    inputPerMTok?: number;
    outputPerMTok?: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
    reasoningPerMTok?: number;
    currency?: 'USD';
}

/** Provider 目录的运行时模型视图:能力 + 平台价格。 */
export interface ProviderModelInfo {
    id: string;
    name: string;
    vendor?: string;
    capabilities: ProviderCapabilities;
    pricing?: ProviderModelPricing;
}

export interface LLMProvider {
    readonly id: string;
    readonly name: string;
    readonly defaultModel?: string;
    readonly models: ProviderModel[];

    /** 列出该 provider 当前可用模型(能力 + 平台价格);纯查询、无副作用。 */
    listModels(): ProviderModelInfo[];
    /** 单个模型详情;未知 id → undefined。 */
    modelDetail(id: string): ProviderModelInfo | undefined;

    /**
     * 非流式调用(对应厂商 chat complete 端点)。
     * 返回完整响应,toolCalls 已解析;错误以 ProviderError 异常表达。
     * 与 askStream 共享校验/归一化管线(EQUIV,§9.2)。
     */
    ask(request: LLMRequest): Promise<LLMResponse>;

    /**
     * 流式调用(对应厂商 stream 端点)。
     * 返回事件流,遵循 §7.2 序列不变量;错误以 ProviderError 异常终止流。
     * supportsStreaming:false 时为合成流(基于 ask 网络路径)。
     */
    askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent>;
}
