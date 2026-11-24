import { describe, expect, it, vi } from 'vitest';
import {
    deepseekSearchEndpoint,
    parseBingResults,
    parseDeepSeekResults,
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

describe('parseDeepSeekResults', () => {
    it('只取 web_search_result，补齐 citation 摘要并按 URL 去重', () => {
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
    });

    it('没有结果块返回 undefined，limit 截断有效', () => {
        expect(parseDeepSeekResults({ content: [{ type: 'text', text: '只有正文' }] })).toBeUndefined();
        expect(parseDeepSeekResults(DEEPSEEK_PAYLOAD, 1)).toHaveLength(1);
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

describe('web.search', () => {
    it('无 DeepSeek Key 时降级 Bing，构造检索请求并格式化候选来源', async () => {
        const fetchImpl = vi.fn(async () => new Response(HTML, { status: 200 }));
        const tool = webSearchToolConfig({ fetchImpl: fetchImpl as unknown as typeof fetch });
        const result = await tool.impl?.({ query: '副业', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1. 副业方向 & 选择');
        expect(String(result?.content)).toContain('https://example.org/b');
        const [url] = fetchImpl.mock.calls[0] as [string];
        expect(url).toContain('https://cn.bing.com/search');
        expect(url).toContain('q=%E5%89%AF%E4%B8%9A');
        expect(url).toContain('count=2');
    });

    it('有 DeepSeek Key 时走原生搜索，不抓 Bing HTML', async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(JSON.stringify(DEEPSEEK_PAYLOAD), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            deepseek: { apiKey: 'test-key', model: 'deepseek-flash' },
        });
        const result = await tool.impl?.({ query: '智能体开发工程师 招聘', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1. 结果 A');
        expect(String(result?.content)).toContain('发布：2 days');
        expect(String(result?.content)).toContain('引用摘要 A');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.deepseek.com/anthropic/v1/messages');
        expect((init.headers as Record<string, string>)['x-api-key']).toBe('test-key');
        const body = JSON.parse(String(init.body)) as {
            model: string;
            tools: Array<{ type: string; name: string; max_uses: number }>;
            messages: Array<{ content: Array<{ text: string }> }>;
        };
        expect(body.model).toBe('deepseek-flash');
        expect(body.tools[0]).toEqual({
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
        });
        expect(body.messages[0]?.content[0]?.text).toBe(
            'Perform a web search for the query: 智能体开发工程师 招聘',
        );
    });

    it('原生搜索没有结果块时失败，不回退 Bing', async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(JSON.stringify({ content: [{ type: 'text', text: '正文' }] }), {
                    status: 200,
                }),
        );
        const tool = webSearchToolConfig({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            deepseek: { apiKey: 'test-key' },
        });
        const result = await tool.impl?.({ query: 'x' });
        expect(result?.ok).toBe(false);
        expect(result?.error).toContain('no web_search_tool_result');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('空 query 直接失败，HTTP 异常收敛为 ok:false', async () => {
        const tool = webSearchToolConfig({
            fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
        });
        expect((await tool.impl?.({ query: '   ' }))?.ok).toBe(false);
        const failed = await tool.impl?.({ query: 'x' });
        expect(failed?.ok).toBe(false);
        expect(failed?.error).toContain('HTTP 500');
    });
});
