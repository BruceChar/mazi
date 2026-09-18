/**
 * ContextManager — Task 级上下文状态与组装。
 *
 * 职责：持有 system prompt / 前置消息 / 工具 schema 与动态轮次消息，动态组合多来源
 * 贡献，内聚跨轮上下文计量基线，并在敏感内容进入 context 前断流为 authz voucher。
 * 本版不实现自动压缩，只暴露 shouldCompact 决策点。
 */

import type { authz, LLMMessage, RuntimeContextBreakdown, ToolSchema } from '@mazi/core';

import { measureContext } from './context-measure.js';

/** 敏感内容的 voucher：不透明句柄 + 策展属性，原文不进入 context。 */
export interface ContextSecretRef {
    handle: string;
    attributes: authz.SecretAttributes;
}

/** 原文到 voucher 的断流端口（V3 机制二）；由 authz SecretService 适配。 */
export interface SecretRedactor {
    redact(value: string): ContextSecretRef;
}

/** 秘密内容进入 context 但没有断流端口：fail-closed，绝不回注明文。 */
export class SecretRedactionUnavailableError extends Error {
    readonly code = 'SECRET_REDACTION_UNAVAILABLE' as const;
    constructor() {
        super('秘密级内容进入 context 但未装配 SecretRedactor：拒绝（fail-closed）');
        this.name = 'SecretRedactionUnavailableError';
    }
}

/** 动态上下文贡献：任一维度可按需参与组装，按注册顺序求值。 */
export interface ContextContribution {
    id: string;
    systemPrompt?: () => string | undefined;
    messages?: () => LLMMessage[];
    tools?: () => ToolSchema[];
}

export interface ContextAssistantTurn {
    text: string;
    toolCalls: readonly {
        callId: string;
        name: string;
        arguments: Record<string, unknown>;
    }[];
}

export interface ContextToolObservation {
    callId: string;
    output: string;
    isError?: boolean;
    /** secret 表示原文不进入 context，改为 voucher。 */
    sensitivity?: 'plain' | 'secret';
}

/** 空成功结果的显式标记：空输出必须带状态，避免模型误判为“没拿到结果”而反复重试。 */
export const EMPTY_SUCCESS_OUTPUT = '[ok] (no output)';
/** 无详情的失败标记。 */
export const EMPTY_ERROR_OUTPUT = '[error] (no detail)';

/**
 * 把工具执行结果渲染为模型可识别的“结果 + 状态”文本：
 * - 成功且有输出：原样返回；
 * - 成功但输出为空：EMPTY_SUCCESS_OUTPUT；
 * - 失败：以 [error] 前缀标注，无详情时用 EMPTY_ERROR_OUTPUT。
 * 幂等：对已标注的文本再次调用不会重复加前缀。
 */
export function formatToolObservation(output: string, isError: boolean): string {
    const trimmed = output.trim();
    if (isError) {
        if (trimmed.length === 0) return EMPTY_ERROR_OUTPUT;
        return trimmed.startsWith('[error]') ? output : `[error] ${output}`;
    }
    return trimmed.length > 0 ? output : EMPTY_SUCCESS_OUTPUT;
}

export interface ContextManagerOptions {
    systemPrompt?: string;
    tools?: readonly ToolSchema[];
    history?: readonly LLMMessage[];
    contributions?: readonly ContextContribution[];
    redactor?: SecretRedactor;
    /** 单轮 assistant 正文回注截断上限（默认 4000，保持既有行为）。 */
    assistantTextMax?: number;
}

export const SECRET_REF_FIELD = '$secretRef';

export function serializeSecretRef(ref: ContextSecretRef): string {
    return JSON.stringify({ [SECRET_REF_FIELD]: ref.handle, attributes: ref.attributes });
}

export function parseSecretRef(value: string): ContextSecretRef | undefined {
    try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        const handle = parsed[SECRET_REF_FIELD];
        if (typeof handle !== 'string') return undefined;
        const attributes = parsed.attributes;
        return {
            handle,
            attributes: (attributes !== null && typeof attributes === 'object'
                ? attributes
                : {}) as authz.SecretAttributes,
        };
    } catch {
        return undefined;
    }
}

/**
 * 把 authz SecretService 适配为 SecretRedactor。refId / purpose / allowedSinks 由
 * 调用方按观察值给出，保证每次断流绑定到具体用途。
 */
export function secretServiceRedactor(
    service: authz.SecretService,
    specOf: (value: string) => Omit<authz.SeverInput, 'value'>,
): SecretRedactor {
    return {
        redact: (value) => {
            const severed = service.sever({ ...specOf(value), value });
            return { handle: severed.handle, attributes: severed.attributes };
        },
    };
}

interface ContributionSnapshot {
    messages: LLMMessage[];
    fragments: string[];
    tools: ToolSchema[];
}

/**
 * Task 级上下文管理器。组装顺序为 [history, 贡献消息..., 动态轮次消息...]，
 * 因此 baseMessageCount 可把“本步新增”与前置上下文区分开。
 */
export class ContextManager {
    private readonly staticSystemPrompt?: string;
    private readonly staticTools: readonly ToolSchema[];
    private readonly history: readonly LLMMessage[];
    private readonly contributions = new Map<string, ContextContribution>();
    private readonly redactor?: SecretRedactor;
    private readonly assistantTextMax: number;
    private readonly dynamic: LLMMessage[] = [];
    private lastTotalTokens?: number;
    private lastMessageCount?: number;

    constructor(opts: ContextManagerOptions = {}) {
        this.staticSystemPrompt = opts.systemPrompt;
        this.staticTools = opts.tools ?? [];
        this.history = opts.history ?? [];
        this.redactor = opts.redactor;
        this.assistantTextMax = opts.assistantTextMax ?? 4000;
        for (const contribution of opts.contributions ?? []) this.addContribution(contribution);
    }

    addContribution(contribution: ContextContribution): void {
        this.contributions.set(contribution.id, contribution);
    }

    removeContribution(id: string): boolean {
        return this.contributions.delete(id);
    }

    appendUser(text: string): void {
        this.dynamic.push({ role: 'user', content: [{ type: 'text', text }] });
    }

    appendAssistant(turn: ContextAssistantTurn): void {
        const text =
            turn.text.length > this.assistantTextMax
                ? turn.text.slice(0, this.assistantTextMax)
                : turn.text;
        this.dynamic.push({
            role: 'assistant',
            content: text.length > 0 ? [{ type: 'text', text }] : [],
            toolCalls: turn.toolCalls.map((call) => ({
                callId: call.callId,
                name: call.name,
                arguments: call.arguments,
            })),
        });
    }

    appendToolResults(results: readonly ContextToolObservation[]): void {
        this.dynamic.push({
            role: 'tool',
            results: results.map((result) => ({
                callId: result.callId,
                output: formatToolObservation(this.projectOutput(result), result.isError === true),
                ...(result.isError ? { isError: true } : {}),
            })),
        });
    }

    messages(): LLMMessage[] {
        const snapshot = this.snapshotContributions();
        return [...this.history, ...snapshot.messages, ...this.dynamic];
    }

    baseMessageCount(): number {
        return this.history.length + this.snapshotContributions().messages.length;
    }

    systemPrompt(): string | undefined {
        const parts = [this.staticSystemPrompt, ...this.snapshotContributions().fragments].filter(
            (part): part is string => typeof part === 'string' && part.length > 0,
        );
        return parts.length > 0 ? parts.join('\n\n') : undefined;
    }

    tools(): ToolSchema[] {
        const merged = new Map<string, ToolSchema>();
        for (const tool of this.staticTools) merged.set(tool.name, tool);
        for (const tool of this.snapshotContributions().tools) merged.set(tool.name, tool);
        return [...merged.values()];
    }

    dynamicMessageCount(): number {
        return this.dynamic.length;
    }

    /** 实现 round-types.ContextMeter：跨轮 delta 基线由本类持有。 */
    measure(contextWindow: number): RuntimeContextBreakdown {
        // 首轮以 baseMessageCount 作为基线，前置历史/贡献消息不计入“本步新增”。
        const baseline = this.lastMessageCount ?? this.baseMessageCount();
        const breakdown = measureContext(
            { messages: this.messages(), systemPrompt: this.systemPrompt(), tools: this.tools() },
            this.lastTotalTokens,
            baseline,
            contextWindow,
        );
        this.lastTotalTokens = breakdown.totalContextTokens;
        this.lastMessageCount = this.messages().length;
        return breakdown;
    }

    /** 压缩决策点：按传入窗口计算占有率，不触发压缩动作。 */
    shouldCompact(contextWindow: number, threshold = 0.9): boolean {
        if (contextWindow <= 0) return false;
        const total = this.lastTotalTokens ?? this.estimateTotalTokens();
        return total / contextWindow >= threshold;
    }

    reset(): void {
        this.dynamic.length = 0;
        this.lastTotalTokens = undefined;
        this.lastMessageCount = undefined;
    }

    private snapshotContributions(): ContributionSnapshot {
        const messages: LLMMessage[] = [];
        const fragments: string[] = [];
        const tools: ToolSchema[] = [];
        for (const contribution of this.contributions.values()) {
            for (const message of contribution.messages?.() ?? []) messages.push(message);
            const fragment = contribution.systemPrompt?.();
            if (typeof fragment === 'string' && fragment.length > 0) fragments.push(fragment);
            for (const tool of contribution.tools?.() ?? []) tools.push(tool);
        }
        return { messages, fragments, tools };
    }

    private estimateTotalTokens(): number {
        return measureContext(
            { messages: this.messages(), systemPrompt: this.systemPrompt(), tools: this.tools() },
            undefined,
            undefined,
            1,
        ).totalContextTokens;
    }

    private projectOutput(observation: ContextToolObservation): string {
        if (observation.sensitivity !== 'secret') return observation.output;
        if (parseSecretRef(observation.output) !== undefined) return observation.output;
        if (!this.redactor) throw new SecretRedactionUnavailableError();
        return serializeSecretRef(this.redactor.redact(observation.output));
    }
}
