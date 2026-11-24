import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    deepseekSearchEndpoint,
    parseBingResults,
    parseDeepSeekResults,
    parseExaResults,
    parsePerplexityOutcome,
    resolveWebSearchProvider,
    type WebSearchProvider,
    webSearchToolConfig,
} from '../src/harness/web-search.js';

const HTML = `
<ul>
<li class="b_algo">
  <h2><a href="https://example.com/a" target="_blank">副业方向 &amp; 选择</a></h2>
  <p class="b_lineclamp2">第一段摘要，<b>包含</b> 标签。</p>
</li>
<li class="b_algo">
  <h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy9i&amp;ntb=1">Second result</a></h2>
  <p>第二段摘要。</p>
</li>
<li class="b_algo"><div>没有链接的块</div></li>
</ul>`;

const DEEPSEEK_PAYLOAD = {
    content: [
        {
            type: 'text',
            text: '这是带引用的回答。',
            citations: [
                { url: 'https://example.com/a', cited_text: '引用摘要 A' },
                { url: 'https://example.com/b', cited_text: '引用摘要 B' },
            ],
        },
        {
            type: 'web_search_tool_result',
            content: [
                {
                    type: 'web_search_result',
                    url: 'https://example.com/a',
                    title: '结果 A',
                    page_age: '2 days',
                },
                {
                    type: 'web_search_result',
                    url: 'https://example.com/b',
                    title: '结果 B',
                    snippet: '自带摘要 B',
                },
                {
                    type: 'web_search_result',
                    url: 'https://example.com/a',
                    title: '重复 A',
                },
            ],
        },
    ],
};

const testEnvKeys = [
    'TEST_DS_KEY',
    'TEST_EXA_KEY',
    'TEST_PPLX_KEY',
    'DEEPSEEK_SEARCH_API_KEY',
    'EXA_API_KEY',
    'PERPLEXITY_API_KEY',
] as const;
afterEach(() => {
    for (const key of testEnvKeys) delete process.env[key];
});

function provider(id: string, kind: 'primary' | 'fallback', available: boolean): WebSearchProvider {
    return {
        id,
        kind,
        available: () => available,
        search: async () => ({ sources: [] }),
    };
}

describe('parseBingResults', () => {
    it('解析标题、URL、摘要，并还原 Bing 跳转链接', () => {
        const results = parseBingResults(HTML, 5);
        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({
            title: '副业方向 & 选择',
            url: 'https://example.com/a',
            snippet: '第一段摘要， 包含 标签。',
        });
        expect(results[1]?.url).toBe('https://example.org/b');
    });

    it('按 limit 截断，结构不匹配返回空', () => {
        expect(parseBingResults(HTML, 1)).toHaveLength(1);
        expect(parseBingResults('<div>no results</div>')).toEqual([]);
    });
});

describe('provider 结果解析', () => {
    it('DeepSeek：只取 web_search_result，补齐 citation 摘要并按 URL 去重', () => {
        const results = parseDeepSeekResults(DEEPSEEK_PAYLOAD, 8);
        expect(results).toEqual([
            {
                title: '结果 A',
                url: 'https://example.com/a',
                snippet: '引用摘要 A',
                publishedAt: '2 days',
            },
            {
                title: '结果 B',
                url: 'https://example.com/b',
                snippet: '自带摘要 B',
            },
        ]);
        expect(parseDeepSeekResults({ content: [{ type: 'text', text: '只有正文' }] })).toBeUndefined();
    });

    it('Exa：取 highlight 与 publishedDate，保留无摘要来源', () => {
        const results = parseExaResults(
            {
                results: [
                    {
                        url: 'https://example.com/a',
                        title: 'A',
                        publishedDate: '2026-01-01',
                        highlights: ['', '摘要 A'],
                    },
                    { url: 'https://example.com/b', title: 'B' },
                ],
            },
            2,
        );
        expect(results).toEqual([
            {
                title: 'A',
                url: 'https://example.com/a',
                snippet: '摘要 A',
                publishedAt: '2026-01-01',
            },
            { title: 'B', url: 'https://example.com/b', snippet: '' },
        ]);
    });

    it('Perplexity：answer + search_results，缺省回退 citations', () => {
        const structured = parsePerplexityOutcome(
            {
                choices: [{ message: { content: '生成摘要' } }],
                search_results: [
                    { url: 'https://example.com/a', title: 'A', snippet: '摘要 A', date: '2026-01-01' },
                ],
            },
            1,
        );
        expect(structured.answer).toBe('生成摘要');
        expect(structured.sources[0]?.snippet).toBe('摘要 A');
        expect(parsePerplexityOutcome({ citations: ['https://example.com/b'] }, 1).sources[0]).toEqual({
            title: 'https://example.com/b',
            url: 'https://example.com/b',
            snippet: '',
        });
    });
});

describe('deepseekSearchEndpoint', () => {
    it('归一 chat base 与 Anthropic base', () => {
        expect(deepseekSearchEndpoint()).toBe('https://api.deepseek.com/anthropic/v1/messages');
        expect(deepseekSearchEndpoint('https://api.deepseek.com')).toBe(
            'https://api.deepseek.com/anthropic/v1/messages',
        );
        expect(deepseekSearchEndpoint('https://api.deepseek.com/v1')).toBe(
            'https://api.deepseek.com/anthropic/v1/messages',
        );
        expect(deepseekSearchEndpoint('https://proxy.example/anthropic/v1')).toBe(
            'https://proxy.example/anthropic/v1/messages',
        );
    });
});

describe('provider 选择', () => {
    it('显式 id 优先；未注册/unavailable 都报错', () => {
        const providers = [provider('exa', 'primary', true), provider('bing', 'fallback', true)];
        expect(resolveWebSearchProvider(providers, 'exa').id).toBe('exa');
        expect(() => resolveWebSearchProvider(providers, 'deepseek')).toThrow('not registered');
        expect(() =>
            resolveWebSearchProvider([provider('exa', 'primary', false)], 'exa'),
        ).toThrow('unavailable');
    });

    it('无配置时只接受唯一 primary；多个 primary 要求显式配置；无 primary 用 fallback', () => {
        expect(resolveWebSearchProvider([provider('exa', 'primary', true)], undefined).id).toBe(
            'exa',
        );
        expect(() =>
            resolveWebSearchProvider(
                [provider('exa', 'primary', true), provider('deepseek', 'primary', true)],
                undefined,
            ),
        ).toThrow('multiple web search providers');
        expect(
            resolveWebSearchProvider(
                [provider('exa', 'primary', false), provider('bing', 'fallback', true)],
                undefined,
            ).id,
        ).toBe('bing');
    });
});

describe('web.search', () => {
    it('没有主 provider 时自动落到 Bing fallback', async () => {
        const fetchImpl = vi.fn(async () => new Response(HTML, { status: 200 }));
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await tool.impl?.({ query: '副业', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('2 条，bing');
        expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('cn.bing.com');
    });

    it('显式 bing：无 Key 也可用，构造检索请求并格式化', async () => {
        const fetchImpl = vi.fn(async () => new Response(HTML, { status: 200 }));
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            config: { provider: 'bing' },
        });
        const result = await tool.impl?.({ query: '副业', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1. 副业方向 & 选择');
        expect(String(result?.content)).toContain('2 条，bing');
        const [url] = fetchImpl.mock.calls[0] as [string];
        expect(url).toContain('https://cn.bing.com/search');
        expect(url).toContain('q=%E5%89%AF%E4%B8%9A');
        expect(url).toContain('count=2');
    });

    it('显式 deepseek：独立搜索 Key，原生搜索，不抓 Bing HTML', async () => {
        process.env.TEST_DS_KEY = 'test-key';
        const fetchImpl = vi.fn(
            async () =>
                new Response(JSON.stringify(DEEPSEEK_PAYLOAD), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            config: {
                provider: 'deepseek',
                deepseek: { apiKeyEnv: 'TEST_DS_KEY', model: 'deepseek-flash' },
            },
        });
        const result = await tool.impl?.({ query: '智能体开发工程师 招聘', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1. 结果 A');
        expect(String(result?.content)).toContain('2 条，deepseek');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
        expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
        const body = JSON.parse(String(init.body)) as {
            model: string;
            tools: Array<{ type: string; name: string; max_uses: number }>;
        };
        expect(body.model).toBe('deepseek-flash');
        expect(body.tools[0]).toEqual({
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
        });
    });

    it('未配置 webSearch 时，deepseek 聊天 Key 只作为凭证兜底，自动选中 deepseek', async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(JSON.stringify(DEEPSEEK_PAYLOAD), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            chatProviders: [
                {
                    id: 'deepseek',
                    driver: {
                        type: 'pi-ai',
                        provider: 'deepseek',
                        model: 'deepseek-flash',
                        apiKey: 'chat-provider-key',
                    },
                    pricing: { currency: 'USD', base: {} },
                },
            ],
        });
        const result = await tool.impl?.({ query: 'x', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('2 条，deepseek');
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
            'https://api.deepseek.com/anthropic/v1/messages',
        );
    });

    it('聊天 provider 仍配置 deepseek，显式 exa 时检索只走 exa', async () => {
        process.env.TEST_EXA_KEY = 'exa-key';
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        results: [{ url: 'https://example.com/a', title: 'A', highlights: ['A'] }],
                    }),
                    { status: 200 },
                ),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            config: { provider: 'exa', exa: { apiKeyEnv: 'TEST_EXA_KEY' } },
            chatProviders: [
                {
                    id: 'deepseek',
                    driver: {
                        type: 'pi-ai',
                        provider: 'deepseek',
                        model: 'deepseek-flash',
                        apiKey: 'chat-provider-key',
                    },
                    pricing: { currency: 'USD', base: {} },
                },
            ],
        });
        const result = await tool.impl?.({ query: 'x', limit: 1 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1 条，exa');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.exa.ai/search');
    });

    it('显式 exa：走 Exa search API', async () => {
        process.env.TEST_EXA_KEY = 'exa-key';
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        results: [
                            {
                                url: 'https://example.com/a',
                                title: 'A',
                                highlights: ['摘要 A'],
                                publishedDate: '2026-01-01',
                            },
                        ],
                    }),
                    { status: 200 },
                ),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            config: { provider: 'exa', exa: { apiKeyEnv: 'TEST_EXA_KEY' } },
        });
        const result = await tool.impl?.({ query: 'x', limit: 1 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1 条，exa');
        expect(String(result?.content)).toContain('发布：2026-01-01');
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.exa.ai/search');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer exa-key');
        expect(JSON.parse(String(init.body))).toMatchObject({ query: 'x', numResults: 1 });
    });

    it('显式 perplexity：answer + sources', async () => {
        process.env.TEST_PPLX_KEY = 'pplx-key';
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        choices: [{ message: { content: '生成摘要' } }],
                        search_results: [{ url: 'https://example.com/a', title: 'A', snippet: '摘要 A' }],
                    }),
                    { status: 200 },
                ),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            config: { provider: 'perplexity', perplexity: { apiKeyEnv: 'TEST_PPLX_KEY' } },
        });
        const result = await tool.impl?.({ query: 'x', limit: 1 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('生成摘要');
        expect(String(result?.content)).toContain('1 条，perplexity');
    });

    it('未知 provider、空 query、HTTP 异常都收敛为 ok:false', async () => {
        const tool = webSearchToolConfig({
            fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
            config: { provider: 'missing' },
        });
        expect((await tool.impl?.({ query: '   ' }))?.ok).toBe(false);
        const unknown = await tool.impl?.({ query: 'x' });
        expect(unknown?.ok).toBe(false);
        expect(unknown?.error).toContain('not registered');
        const bing = webSearchToolConfig({
            fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
            config: { provider: 'bing' },
        });
        const failed = await bing.impl?.({ query: 'x' });
        expect(failed?.ok).toBe(false);
        expect(failed?.error).toContain('HTTP 500');
    });

    it('DeepSeek 没有结果块时失败，不回退 Bing', async () => {
        process.env.TEST_DS_KEY = 'test-key';
        const fetchImpl = vi.fn(
            async () =>
                new Response(JSON.stringify({ content: [{ type: 'text', text: '正文' }] }), {
                    status: 200,
                }),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            config: { provider: 'deepseek', deepseek: { apiKeyEnv: 'TEST_DS_KEY' } },
        });
        const result = await tool.impl?.({ query: 'x' });
        expect(result?.ok).toBe(false);
        expect(result?.error).toContain('no web_search_tool_result');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
