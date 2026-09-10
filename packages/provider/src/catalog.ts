/**
 * catalog —— pi-ai 内置厂商模型目录读取（用于 providers.json 模型列表同步）。
 * 仅暴露「厂商 → 模型元数据」的只读映射；未知厂商/目录缺失时返回空数组（不抛错、不覆盖配置）。
 */
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';

/** providers.json models 条目的最小形态。 */
export interface CatalogModel {
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    supportsThinking: boolean;
    supportsTools: boolean;
}

/** 读取指定厂商（pi-ai provider id，如 deepseek）的模型目录；未知厂商 → []。 */
export function builtinModelsFor(vendor: string): CatalogModel[] {
    try {
        if (!vendor || !(getBuiltinProviders() as string[]).includes(vendor)) {
            return [];
        }
        const models = getBuiltinModels(vendor as never) as unknown as Array<{
            id: string;
            name: string;
            contextWindow: number;
            maxTokens: number;
            reasoning: boolean;
            input: string[];
        }>;
        return models.map((model) => ({
            id: model.id,
            name: model.name,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            supportsThinking: model.reasoning,
            supportsTools: model.input.includes('text'),
        }));
    } catch {
        return [];
    }
}

/** 目录内置的全部厂商 id（诊断用）。 */
export function builtinVendors(): string[] {
    try {
        return getBuiltinProviders() as string[];
    } catch {
        return [];
    }
}
