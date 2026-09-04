import type { Models } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { discoverModels } from './model-discovery.js';

function fakeModels(
    staticIds: string[],
    behavior: 'refresh-ok' | 'refresh-fail' = 'refresh-ok',
): Models {
    let fresh: string[] | undefined;
    return {
        getModels: (provider?: string) => {
            const ids = fresh ?? staticIds;
            void provider;
            return ids.map((id) => ({ id, provider: 'x' }) as never) as never;
        },
        refresh: async () => {
            if (behavior === 'refresh-fail') {
                throw new Error('network-down');
            }
            fresh = ['model-latest-1', 'model-latest-2'];
            return { aborted: false, errors: new Map() } as never;
        },
    } as unknown as Models;
}

describe('model discovery（设计文档 §2 / U3）', () => {
    it('无 key：不回退网络，直接用本地目录并 refreshed=false', async () => {
        delete process.env.OPENAI_API_KEY;
        const models = fakeModels(['gpt-4o-mini', 'gpt-4o']);
        const res = await discoverModels('openai', {}, { models });
        expect(res.refreshed).toBe(false);
        expect(res.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    });

    it('有 key 且 refresh 成功：返回刷新后的最新列表', async () => {
        process.env.DEEPSEEK_API_KEY = 'sk-test';
        try {
            const models = fakeModels(['old-1']);
            const res = await discoverModels('deepseek', {}, { models });
            expect(res.refreshed).toBe(true);
            expect(res.models).toEqual(['model-latest-1', 'model-latest-2']);
        } finally {
            delete process.env.DEEPSEEK_API_KEY;
        }
    });

    it('refresh 失败：回退本地目录并附 warning（不抛错）', async () => {
        process.env.OPENAI_API_KEY = 'sk-x';
        try {
            const models = fakeModels(['gpt-4o'], 'refresh-fail');
            const res = await discoverModels('openai', {}, { models });
            expect(res.refreshed).toBe(false);
            expect(res.models).toEqual(['gpt-4o']);
            expect(res.warning).toContain('network-down');
        } finally {
            delete process.env.OPENAI_API_KEY;
        }
    });

    it('结果去重排序', async () => {
        const models = fakeModels(['b-model', 'a-model', 'a-model']);
        const res = await discoverModels('faux', {}, { models });
        expect(res.models).toEqual(['a-model', 'b-model']);
    });
});
