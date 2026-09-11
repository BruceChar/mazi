import { describe, expect, it } from 'vitest';
import { deepseekAdapter, knownDeepseekModels } from './from-config.js';

describe('deepseekAdapter（真实厂商 adapter 目录，离线）', () => {
    it('knownDeepseekModels：pi-ai 目录含 v4 系列', () => {
        const ids = knownDeepseekModels();
        expect(ids).toContain('deepseek-v4-flash');
        expect(ids).toContain('deepseek-v4-pro');
    });

    it('合法配置 → LLMProvider：defaultModel=config.models[0]，模型来自目录', () => {
        const provider = deepseekAdapter(
            {
                id: 'ds',
                adapter: 'deepseek',
                apiKeyEnv: 'DS_KEY',
                models: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }],
            },
            { env: { DS_KEY: 'sk-test' } },
        );
        expect(provider.id).toBe('deepseek');
        expect(provider.defaultModel).toBe('deepseek-v4-flash');
        expect(provider.models.map((m) => m.id).sort()).toEqual([
            'deepseek-v4-flash',
            'deepseek-v4-flash-vision-exp',
            'deepseek-v4-pro',
        ]);
    });

    it('配置模型不在目录 → 以目录模板合成（可解析、可发往厂商）', () => {
        const provider = deepseekAdapter(
            { id: 'ds', adapter: 'deepseek', models: [{ id: 'deepseek-v5-experimental' }] },
            { env: {} },
        );
        expect(provider.defaultModel).toBe('deepseek-v5-experimental');
        expect(provider.listModels().some((m) => m.id === 'deepseek-v5-experimental')).toBe(true);
        expect(
            provider.modelDetail('deepseek-v5-experimental')?.capabilities.supportsReasoning,
        ).toBe(true);
        // 目录模型仍在
        expect(provider.listModels().some((m) => m.id === 'deepseek-v4-flash')).toBe(true);
    });

    it('adapter 标识不符 → 报错', () => {
        expect(() =>
            deepseekAdapter(
                { id: 'x', adapter: 'openai', models: [{ id: 'deepseek-v4-flash' }] },
                { env: {} },
            ),
        ).toThrow(/adapter must be 'deepseek'/);
    });
});
