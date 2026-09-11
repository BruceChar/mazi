import { describe, expect, it } from 'vitest';
import { discoverModels } from './from-config.js';
import { fetchRemoteModelIds, parseModelIds } from './model-discovery.js';

describe('model-discovery：厂商 /models 在线发现', () => {
    it('parseModelIds 解析 OpenAI/DeepSeek 兼容响应并去重排序', () => {
        expect(
            parseModelIds({
                object: 'list',
                data: [
                    { id: 'deepseek-v4-pro' },
                    { id: 'deepseek-flash' },
                    { id: 'deepseek-flash' },
                ],
            }),
        ).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
        expect(parseModelIds(null)).toEqual([]);
        expect(parseModelIds({ data: 'nope' })).toEqual([]);
        expect(parseModelIds({ data: [{ id: 42 }, {}] })).toEqual([]);
    });

    it('fetchRemoteModelIds 携带 Bearer 并请求 /models（可注入 fetch）', async () => {
        const calls: Array<{ url: string; auth?: string }> = [];
        const fakeFetch: typeof fetch = async (input, init) => {
            const url = String(input);
            const headers = (init?.headers ?? {}) as Record<string, string>;
            calls.push({ url, ...(headers.authorization ? { auth: headers.authorization } : {}) });
            return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        };
        const ids = await fetchRemoteModelIds({
            providerId: 'deepseek',
            apiKey: 'sk-test',
            baseUrl: 'https://api.deepseek.com/',
            fetchImpl: fakeFetch,
        });
        expect(ids).toEqual(['deepseek-flash']);
        expect(calls[0]?.url).toBe('https://api.deepseek.com/models');
        expect(calls[0]?.auth).toBe('Bearer sk-test');
    });

    it('非 2xx 抛错（由调用方回退）', async () => {
        const fakeFetch: typeof fetch = async () => new Response('nope', { status: 401 });
        await expect(
            fetchRemoteModelIds({ providerId: 'deepseek', apiKey: 'x', fetchImpl: fakeFetch }),
        ).rejects.toThrow(/models endpoint returned 401/);
    });

    it('discoverModels 在线优先，成功时 refreshed=true / source=remote', async () => {
        const fakeFetch: typeof fetch = async () =>
            new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 });
        const result = await discoverModels('deepseek', {
            env: { DEEPSEEK_API_KEY: 'sk-test' },
            fetchImpl: fakeFetch,
        });
        expect(result).toEqual({ models: ['deepseek-flash'], refreshed: true, source: 'remote' });
    });

    it('discoverModels 无 Key → 回退本地目录并给出 warning', async () => {
        const result = await discoverModels('deepseek', { env: {} });
        expect(result.refreshed).toBe(false);
        expect(result.source).toBe('local');
        expect(result.models).toContain('deepseek-v4-flash');
        expect(result.warning).toMatch(/API Key/);
    });

    it('discoverModels 在线失败 → 回退本地目录并给出 warning', async () => {
        const fakeFetch: typeof fetch = async () => new Response('boom', { status: 500 });
        const result = await discoverModels('deepseek', {
            env: { DEEPSEEK_API_KEY: 'sk-test' },
            fetchImpl: fakeFetch,
        });
        expect(result.source).toBe('local');
        expect(result.warning).toMatch(/调用失败/);
    });

    it('未知 provider → source=none', async () => {
        const result = await discoverModels('openai', { env: {} });
        expect(result.source).toBe('none');
    });
});
