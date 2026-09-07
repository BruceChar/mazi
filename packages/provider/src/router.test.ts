import type { ModelDescriptor, Provider } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { ProviderJson } from './registry.js';
import { normalizeProvider } from './registry.js';
import { SimpleRouter } from './router.js';

/** 能力模型工厂：缺省不支持任何能力 */
function model(over: Partial<ModelDescriptor> & { id: string }): ModelDescriptor {
    return {
        contextWindow: 32_000,
        supportsTools: false,
        supportsThinking: false,
        supportsVision: false,
        ...over,
    };
}

/** ProviderJson 工厂：vendor/models 缺省后由 over 覆盖 */
function providerJson(id: string, over: Partial<ProviderJson> = {}): ProviderJson {
    return { vendor: 'test', models: [], ...over, id };
}

describe('SimpleRouter（MVP v1.0 §8 F5 / §5.1、E7）', () => {
    it('能力过滤 tools：非能力标签不参与，模型级 supportsTools 满足', () => {
        const cheapNoTool = normalizeProvider(
            providerJson('cheap-no-tool', {
                models: [model({ id: 'c' })],
                pricing: { base: { inputPerMTok: 0.1, outputPerMTok: 0.3 } },
            }),
        );
        const tooled = normalizeProvider(
            providerJson('tooled', {
                models: [model({ id: 't', supportsTools: true })],
                pricing: { base: { inputPerMTok: 2, outputPerMTok: 6 } },
            }),
        );
        const router = new SimpleRouter([cheapNoTool, tooled]);
        const matches = router.candidates(['tools', 'general', 'poetry']);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.provider.id).toBe('tooled');
        expect(matches[0]?.model).toEqual({
            providerId: 'tooled',
            vendor: 'test',
            modelId: 't',
        });
        expect(router.select(['tools']).provider.id).toBe('tooled');
    });

    it('能力过滤 vision/thinking/long-context（long-context 边界 128000）', () => {
        const eye = normalizeProvider(
            providerJson('eye', { models: [model({ id: 'eye-v', supportsVision: true })] }),
        );
        const brain = normalizeProvider(
            providerJson('brain', {
                models: [model({ id: 'brain-m', supportsThinking: true, contextWindow: 200_000 })],
            }),
        );
        const border = normalizeProvider(
            providerJson('border', {
                models: [model({ id: 'border-m', contextWindow: 128_000 })],
            }),
        );
        const small = normalizeProvider(
            providerJson('small', {
                models: [model({ id: 'small-m', contextWindow: 127_999 })],
            }),
        );
        const router = new SimpleRouter([eye, brain, border, small]);
        const ids = (tags: string[]): string[] =>
            router.candidates(tags).map((candidate) => candidate.provider.id);
        expect(ids(['vision'])).toEqual(['eye']);
        expect(ids(['thinking'])).toEqual(['brain']);
        expect(ids(['long-context'])).toEqual(['border', 'brain']);
        expect(ids(['thinking', 'long-context'])).toEqual(['brain']);
    });

    it('provider.tags 声明能力也可通过过滤；候选模型退化为首个模型', () => {
        const tagOnly = normalizeProvider(
            providerJson('taggy', { tags: ['tools'], models: [model({ id: 'taggy-m' })] }),
        );
        const tooledCheap = normalizeProvider(
            providerJson('tooled-cheap', {
                models: [model({ id: 'tc', supportsTools: true })],
                pricing: { base: { inputPerMTok: 0.5, outputPerMTok: 1.5 } },
            }),
        );
        const router = new SimpleRouter([tagOnly, tooledCheap]);
        const matches = router.candidates(['tools']);
        expect(matches.map((candidate) => candidate.provider.id)).toEqual([
            'tooled-cheap',
            'taggy',
        ]);
        expect(matches[1]?.model.modelId).toBe('taggy-m');
    });

    it('健康过滤：health.score 须严格 > 0.5；缺 health 视为不健康', () => {
        const good = normalizeProvider(
            providerJson('good', { models: [model({ id: 'g', supportsTools: true })] }),
        );
        const half = normalizeProvider(
            providerJson('half', {
                models: [model({ id: 'h', supportsTools: true })],
                health: { score: 0.5 },
            }),
        );
        const low = normalizeProvider(
            providerJson('low', {
                models: [model({ id: 'l', supportsTools: true })],
                health: { score: 0.4 },
            }),
        );
        const noHealth = normalizeProvider(
            providerJson('nohealth', { models: [model({ id: 'n', supportsTools: true })] }),
        );
        delete (noHealth as Partial<Provider>).health;
        const router = new SimpleRouter([good, half, low, noHealth]);
        const matches = router.candidates(['tools']);
        expect(matches.map((candidate) => candidate.provider.id)).toEqual(['good']);
    });

    it('排序：baseUnitCostUsd 升序、同价按 provider.id 字典序，结果确定', () => {
        const alpha = normalizeProvider(
            providerJson('alpha', { models: [model({ id: 'a-m', supportsTools: true })] }),
        );
        const bravo = normalizeProvider(
            providerJson('bravo', { models: [model({ id: 'b-m', supportsTools: true })] }),
        );
        const zeta = normalizeProvider(
            providerJson('zeta', {
                models: [model({ id: 'z-m', supportsTools: true })],
                pricing: { base: { inputPerMTok: 1, outputPerMTok: 9 } },
            }),
        );
        const router = new SimpleRouter([zeta, alpha, bravo]);
        const first = router.candidates(['tools']);
        expect(first.map((candidate) => candidate.provider.id)).toEqual(['alpha', 'bravo', 'zeta']);
        expect(first.map((candidate) => candidate.baseUnitCostUsd)).toEqual([2, 2, 5]);
        // 确定性：重复调用结果一致
        expect(router.candidates(['tools'])).toEqual(first);
        expect(router.select(['tools']).provider.id).toBe('alpha');
    });

    it('无能力标签（含无关标签）仅按健康过滤 + 成本排序', () => {
        const a = normalizeProvider(
            providerJson('a', {
                models: [model({ id: 'a-m' })],
                pricing: { base: { inputPerMTok: 1, outputPerMTok: 1 } },
            }),
        );
        const b = normalizeProvider(
            providerJson('b', {
                models: [model({ id: 'b-m' })],
                pricing: { base: { inputPerMTok: 4, outputPerMTok: 4 } },
            }),
        );
        const sick = normalizeProvider(
            providerJson('sick', {
                models: [model({ id: 's-m' })],
                health: { score: 0.1 },
                pricing: { base: { inputPerMTok: 0.1, outputPerMTok: 0.1 } },
            }),
        );
        const router = new SimpleRouter([sick, b, a]);
        expect(router.candidates([]).map((candidate) => candidate.provider.id)).toEqual(['a', 'b']);
        expect(router.candidates(['general', 'poetry']).map((c) => c.provider.id)).toEqual([
            'a',
            'b',
        ]);
    });

    it('无候选：candidates 返回空数组，select 抛错且信息含输入 tags', () => {
        const router = new SimpleRouter([]);
        expect(router.candidates(['tools'])).toEqual([]);
        expect(() => router.select(['tools', 'vision'])).toThrow('SimpleRouter');
        expect(() => router.select(['tools', 'vision'])).toThrow('tools');
        expect(() => router.select(['tools', 'vision'])).toThrow('vision');
    });
});
