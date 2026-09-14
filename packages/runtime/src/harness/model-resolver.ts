import type { LLMProvider } from '@mazi/core';
import { builtinModelsFor, DEEPSEEK_ADAPTER_ID, deepseekAdapter } from '@mazi/provider';
import type { ExecutorRoundContext } from '../gts/round-types.js';
import type { RuntimeConfig } from '../config.js';
import type { PricingSchedule } from '../provider/index.js';
import type { RunOptions } from './conversation.js';

/** 装配 LLMProvider 池：override 优先；deepseek 经 pi-ai 目录适配（目录不匹配/无 key 在调用期报错，装配期跳过并告警） */
export function buildLlmProviders(
    config: RuntimeConfig,
    options: RunOptions,
): Map<string, LLMProvider> {
    const map = new Map<string, LLMProvider>();
    const overrides = options.llmProviders ?? {};
    // override 独立于 config.providers 注册（测试/宿主注入 provider 不必出现在配置列表）
    for (const [id, provider] of Object.entries(overrides)) {
        map.set(id, provider);
    }
    for (const provider of config.providers) {
        if (map.has(provider.id)) {
            continue;
        }
        if (provider.driver.provider === DEEPSEEK_ADAPTER_ID) {
            try {
                const modelIds = provider.models?.length
                    ? provider.models.map((m) => ({ id: m.id }))
                    : [{ id: provider.driver.model }];
                map.set(
                    provider.id,
                    deepseekAdapter(
                        {
                            id: provider.id,
                            adapter: DEEPSEEK_ADAPTER_ID,
                            apiKeyEnv: provider.driver.apiKeyEnv,
                            ...(provider.driver.apiKey !== undefined
                                ? { apiKey: provider.driver.apiKey }
                                : {}),
                            models: modelIds,
                        },
                        { env: process.env },
                    ),
                );
            } catch (error) {
                // biome-ignore lint/suspicious/noConsole: 装配期跳过告警（面向用户运行日志）
                console.warn(
                    `[runtime] skip provider '${provider.id}': ${(error as Error).message}`,
                );
            }
        }
    }
    return map;
}

/**
 * ModelResolver —— 模型/计价/窗口的 config 查询族。
 * 「查什么价、用哪个模型、窗口多大」归此处；「怎么算钱」归 round-accounting。
 */
export class ModelResolver {
    constructor(
        private readonly config: RuntimeConfig,
        private readonly llmProviders: Map<string, LLMProvider>,
    ) {}

    /** 由模型 id 解析所属 provider（配置内取第一个匹配）；未命中 → undefined。 */
    resolveModelChoice(modelId?: string): { providerId: string; modelId: string } | undefined {
        if (!modelId) {
            return undefined;
        }
        const provider = this.config.providers.find((item) =>
            (item.models ?? []).some((model) => model.id === modelId),
        );
        return provider ? { providerId: provider.id, modelId } : undefined;
    }

    private defaultModelOf(providerId: string): string {
        const entry = this.config.providers.find((p) => p.id === providerId);
        return entry?.driver.model || entry?.models?.[0]?.id || '';
    }

    /**
     * 解析计价表：优先该模型的专属价目（官网抓取按 flash/pro 分别写入），
     * 缺省回落到 provider 级 pricing。
     */
    pricingOf(providerId: string, modelId?: string): PricingSchedule | undefined {
        const entry = this.config.providers.find((p) => p.id === providerId);
        if (entry === undefined) return undefined;
        if (modelId !== undefined) {
            const model = entry.models?.find((item) => item.id === modelId);
            if (model?.pricing !== undefined) return model.pricing;
        }
        return entry.pricing;
    }

    /**
     * 解析生效的上下文窗口（token）：模型级 contextWindow → provider 首个模型 → 运行时兜底。
     * 上下文占比按真实模型窗口计算（如 1M），而非固定 64K。
     */
    contextWindowOf(providerId: string, modelId?: string): number {
        const entry = this.config.providers.find((p) => p.id === providerId);
        const byModel =
            modelId !== undefined ? entry?.models?.find((item) => item.id === modelId) : undefined;
        const fallbackModel = entry?.models?.find(
            (item) => item.id === (entry?.driver.model || entry?.models?.[0]?.id),
        );
        // 目录（pi-ai）里已知模型的窗口兜底（providers.json 未标注 contextWindow 时）。
        const vendor = entry?.driver?.provider ?? '';
        const catalog = builtinModelsFor(vendor);
        const catalogWindow = (id?: string): number | undefined =>
            id !== undefined
                ? catalog.find((info) => info.id === id)?.capabilities.maxInputTokens
                : undefined;
        return (
            byModel?.contextWindow ??
            fallbackModel?.contextWindow ??
            entry?.models?.[0]?.contextWindow ??
            catalogWindow(modelId) ??
            catalogWindow(fallbackModel?.id) ??
            this.config.contextWindow ??
            64000
        );
    }

    /** 解析候选 provider 的模型 id：命中 ctx 目标且非占位值时用 ctx 模型，否则取配置/默认模型 */
    roundModelId(
        id: string,
        ctxModel: { providerId: string; modelId: string },
        provider: LLMProvider,
    ): string | undefined {
        if (id === ctxModel.providerId && ctxModel.modelId && ctxModel.modelId !== 'default') {
            return ctxModel.modelId;
        }
        return this.defaultModelOf(id) || provider.defaultModel || undefined;
    }

    /** 候选 provider 序列（ctx 指定者优先，其余按注册序 failover），含各自的模型 id 与计价表。 */
    buildCandidates(
        ctx: ExecutorRoundContext,
        modelOverride?: string,
    ): Array<{
        providerId: string;
        provider: LLMProvider;
        modelId?: string;
        pricing?: PricingSchedule;
    }> {
        const orderedIds = [
            ctx.model.providerId,
            ...[...this.llmProviders.keys()].filter((id) => id !== ctx.model.providerId),
        ];
        return orderedIds
            .map((id) => ({ id, provider: this.llmProviders.get(id) }))
            .filter((x): x is { id: string; provider: LLMProvider } => x.provider !== undefined)
            .map(({ id, provider }) => {
                const modelId =
                    id === ctx.model.providerId && modelOverride !== undefined
                        ? modelOverride
                        : this.roundModelId(id, ctx.model, provider);
                return {
                    providerId: id,
                    provider,
                    ...(modelId !== undefined ? { modelId } : {}),
                    ...(this.pricingOf(id, modelId) !== undefined
                        ? { pricing: this.pricingOf(id, modelId) }
                        : {}),
                };
            });
    }
}
