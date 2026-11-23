import { describe, expect, it, vi } from 'vitest';
import { parseBingResults, webSearchToolConfig } from '../src/harness/web-search.js';

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

describe('web.search', () => {
    it('构造检索请求并格式化候选来源', async () => {
        const fetchImpl = vi.fn(async () => new Response(HTML, { status: 200 }));
        const tool = webSearchToolConfig(fetchImpl as unknown as typeof fetch);
        const result = await tool.impl?.({ query: '副业', limit: 2 });
        expect(result?.ok).toBe(true);
        expect(String(result?.content)).toContain('1. 副业方向 & 选择');
        expect(String(result?.content)).toContain('https://example.org/b');
        const [url] = fetchImpl.mock.calls[0] as [string];
        expect(url).toContain('https://cn.bing.com/search');
        expect(url).toContain('q=%E5%89%AF%E4%B8%9A');
        expect(url).toContain('count=2');
    });

    it('空 query 直接失败，HTTP 异常收敛为 ok:false', async () => {
        const tool = webSearchToolConfig((async () => new Response('', { status: 500 })) as typeof fetch);
        expect((await tool.impl?.({ query: '   ' }))?.ok).toBe(false);
        const failed = await tool.impl?.({ query: 'x' });
        expect(failed?.ok).toBe(false);
        expect(failed?.error).toContain('HTTP 500');
    });
});
