import type { CapabilityTag, ModelDescriptor, ModelRef, Provider } from '@mazi/core';

/** MVP 识别的硬能力标签（core CapabilityTag 全集，文档 §3.2/§5.1） */
export const CAPABILITY_TAGS: readonly string[] = ['tools', 'vision', 'thinking', 'long-context'];

/** long-context 判定阈值：存在 contextWindow >= 128000 的模型即满足 */
const LONG_CONTEXT_MIN_WINDOW = 128_000;

/** 路由候选：每 Provider 至多一个（含被选中的具体模型与组合基础单价） */
export interface RouteCandidate {
    provider: Provider;
    model: ModelRef;
    /** 组合基础单价 USD/1M token：base（input+output）/2（MVP 无 tier 生效） */
    baseUnitCostUsd: number;
}

/** 单个模型是否满足某能力标签 */
function modelSupports(model: ModelDescriptor, capability: CapabilityTag): boolean {
    switch (capability) {
        case 'tools':
            return model.supportsTools;
        case 'vision':
            return model.supportsVision;
        case 'thinking':
            return model.supportsThinking;
        case 'long-context':
            return model.contextWindow >= LONG_CONTEXT_MIN_WINDOW;
    }
}

/** Provider 是否满足能力标签：tags 声明或存在满足该能力的模型，二者满足其一即可 */
function providerSupports(provider: Provider, capability: CapabilityTag): boolean {
    if (provider.tags.includes(capability)) {
        return true;
    }
    return provider.models.some((model) => modelSupports(model, capability));
}

/** 候选模型：首个满足全部能力标签的模型；无标签或能力仅由 tags 声明时取首个模型 */
function pickModel(provider: Provider, capabilities: CapabilityTag[]): ModelDescriptor | undefined {
    if (capabilities.length === 0) {
        return provider.models[0];
    }
    const matching = provider.models.find((model) =>
        capabilities.every((capability) => modelSupports(model, capability)),
    );
    return matching ?? provider.models[0];
}

function baseUnitCostUsdOf(provider: Provider): number {
    const base = provider.pricing.base;
    return (base.inputPerMTok + base.outputPerMTok) / 2;
}

/**
 * SimpleRouter：
 * 输入 turn.tags 的能力标签（与 CAPABILITY_TAGS 取交集，非能力标签不参与过滤）；
 * 硬过滤：provider.health.score > 0.5 且对每个能力标签满足（tags 声明或能力模型，
 * 缺 health 视为不健康）；排序：baseUnitCostUsd 升序、同价按 provider.id 字典序，
 * 保证确定性；select 无候选时抛错（错误信息含输入 tags）。
 */
export class SimpleRouter {
    private readonly providers: Provider[];

    constructor(providers: Provider[]) {
        this.providers = providers;
    }

    /** 全部候选（已过滤 + 已排序）；无候选返回空数组 */
    candidates(tags: string[]): RouteCandidate[] {
        const capabilities = tags.filter((tag) => CAPABILITY_TAGS.includes(tag)) as CapabilityTag[];
        const result: RouteCandidate[] = [];
        for (const provider of this.providers) {
            const healthScore = provider.health?.score ?? 0;
            if (healthScore <= 0.5) {
                continue;
            }
            if (!capabilities.every((capability) => providerSupports(provider, capability))) {
                continue;
            }
            const model = pickModel(provider, capabilities);
            if (!model) {
                continue;
            }
            result.push({
                provider,
                model: { providerId: provider.id, vendor: provider.vendor, modelId: model.id },
                baseUnitCostUsd: baseUnitCostUsdOf(provider),
            });
        }
        result.sort(
            (a, b) =>
                a.baseUnitCostUsd - b.baseUnitCostUsd || a.provider.id.localeCompare(b.provider.id),
        );
        return result;
    }

    /** 选出排序首位的候选；无候选抛错（错误信息含输入 tags） */
    select(tags: string[]): RouteCandidate {
        const matches = this.candidates(tags);
        if (matches.length === 0) {
            throw new Error(`SimpleRouter: 无可用候选（tags=${JSON.stringify(tags)}）`);
        }
        return matches[0];
    }
}
