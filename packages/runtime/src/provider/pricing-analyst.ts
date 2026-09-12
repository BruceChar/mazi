/**
 * 价目页 Agent 解析器 —— 把厂商官方价目页纯文本交给配置中的模型，要求其回传结构化
 * JSON（见 buildPricingAnalysisPrompt），再严格解析（parseAgentPricingJson）。
 *
 * 定位：**确定性解析器的兜底**。官方页结构变化 / 新厂商页面无法用正则解析时启用；
 * 无可用 provider、无 Key 或调用失败 → 返回 undefined / null，调用方保留既有配置（fail-safe）。
 */
import type { LLMProvider } from '@mazi/core';
import {
    buildPricingAnalysisPrompt,
    DEEPSEEK_ADAPTER_ID,
    deepseekAdapter,
    type ParsedDeepseekPricing,
    parseAgentPricingJson,
    providerCatalog,
} from '@mazi/provider';
import type { RuntimeConfig } from '../config.js';

export interface PricingPage {
    url: string;
    text: string;
}

/** 页面 → 结构化官方价；无结果返回 null（不覆盖既有配置）。 */
export type PricingPageAnalyst = (page: PricingPage) => Promise<ParsedDeepseekPricing | null>;

export interface CreatePricingAnalystOptions {
    env?: Record<string, string | undefined>;
    /** 覆盖调用方（测试注入）；缺省按配置构造适配器。 */
    provider?: LLMProvider;
    /** 目标厂商（vendor）；缺省 deepseek。 */
    vendor?: string;
}

/**
 * 由配置构造某厂商的 Agent 解析器；该厂商无可用 provider / 无对应 adapter → undefined
 * （调用方仅走确定性解析）。按 vendor 选择 provider，支持后续接入多厂商。
 */
export function createPricingAnalyst(
    config: RuntimeConfig,
    options: CreatePricingAnalystOptions = {},
): PricingPageAnalyst | undefined {
    const vendor = options.vendor ?? DEEPSEEK_ADAPTER_ID;
    const entry = config.providers.find(
        (item) => (item.vendor?.trim() || item.driver.provider) === vendor,
    );
    if (entry === undefined) return undefined;
    let provider = options.provider;
    if (provider === undefined) {
        const factory = providerCatalog[entry.driver.provider];
        if (factory === undefined) return undefined;
        const adapterConfig = {
            id: entry.id,
            adapter: entry.driver.provider,
            ...(entry.driver.apiKeyEnv !== undefined ? { apiKeyEnv: entry.driver.apiKeyEnv } : {}),
            ...(entry.driver.apiKey !== undefined ? { apiKey: entry.driver.apiKey } : {}),
            models:
                entry.models !== undefined && entry.models.length > 0
                    ? entry.models.map((model) => ({ id: model.id }))
                    : [{ id: entry.driver.model }],
        };
        try {
            // deepseek adapter 支持注入 env；其余 adapter 走目录工厂（读 process.env）。
            provider =
                entry.driver.provider === DEEPSEEK_ADAPTER_ID
                    ? deepseekAdapter(
                          adapterConfig,
                          options.env !== undefined ? { env: options.env } : {},
                      )
                    : factory(adapterConfig);
        } catch {
            return undefined;
        }
    }
    const model = entry.driver.model;
    const analystProvider = provider;
    return async (page: PricingPage) => {
        const reply = await analystProvider.ask({
            model,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: buildPricingAnalysisPrompt(page.text, page.url) },
                    ],
                },
            ],
        });
        const text = reply.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('\n');
        return parseAgentPricingJson(text, page.url);
    };
}
