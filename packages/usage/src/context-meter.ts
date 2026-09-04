import type { RuntimeContextBreakdown } from '@mazi/core';
import { TokenizerRegistry } from './tokenizer-registry.js';

/** ContextMeter 输入：一次 LLM 请求的各上下文分段原始文本 */
export interface ContextSections {
    systemPrompt: string;
    history: string;
    toolSchema: string;
    newInput: string;
    observation: string;
    /** 检索注入段（可选，MVP 常规缺省） */
    retrieved?: string;
    /** few-shot 示例段（可选） */
    examples?: string;
}

/**
 * 上下文计量器：对分段文本估算 token 并产出 RuntimeContextBreakdown。
 * MVP v1.0 §5.2：仅计量（strategyApplied 恒为 []），不执行任何上下文压缩。
 */
export class ContextMeter {
    private readonly registry: TokenizerRegistry;

    constructor(registry?: TokenizerRegistry) {
        this.registry = registry ?? new TokenizerRegistry();
    }

    /**
     * 计量一次调用前的完整上下文。
     * @param sections 各分段原文（缺省的可选段计 0）
     * @param contextWindow 模型上下文窗口（token）
     * @param prevTotalTokens 上一次调用总 token 数，用于 contextDeltaFromPrev（缺省按 0）
     */
    measure(
        sections: ContextSections,
        contextWindow: number,
        prevTotalTokens?: number,
    ): RuntimeContextBreakdown {
        const count = (text: string | undefined): number =>
            text === undefined ? 0 : this.registry.estimate(text);

        const systemPromptTokens = count(sections.systemPrompt);
        const historyTokens = count(sections.history);
        const toolSchemaTokens = count(sections.toolSchema);
        const newInputTokens = count(sections.newInput);
        const observationTokens = count(sections.observation);
        const retrievedTokens = count(sections.retrieved);
        const exampleTokens = count(sections.examples);

        const totalContextTokens =
            systemPromptTokens +
            historyTokens +
            toolSchemaTokens +
            newInputTokens +
            observationTokens +
            retrievedTokens +
            exampleTokens;

        const systemPromptRatio =
            totalContextTokens > 0 ? systemPromptTokens / totalContextTokens : 0;

        // utilization ∈ [0,1]，超窗封顶为 1；窗口非正时按是否超窗给 1/0
        const contextWindowUtilization =
            contextWindow > 0
                ? Math.min(1, totalContextTokens / contextWindow)
                : totalContextTokens > 0
                  ? 1
                  : 0;

        const contextDeltaFromPrev = totalContextTokens - (prevTotalTokens ?? 0);

        return {
            systemPromptTokens,
            systemPromptRatio,
            historyTokens,
            toolSchemaTokens,
            newInputTokens,
            observationTokens,
            retrievedTokens,
            exampleTokens,
            totalContextTokens,
            contextWindowUtilization,
            contextDeltaFromPrev,
            strategyApplied: [],
        };
    }
}
