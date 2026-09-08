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

    it('配置模型不在目录 → 装配错误（带已知列表）', () => {
        expect(() =>
            deepseekAdapter(
                { id: 'ds', adapter: 'deepseek', models: [{ id: 'not-a-model' }] },
                { env: {} },
            ),
        ).toThrow(/not in pi-ai deepseek catalog/);
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
