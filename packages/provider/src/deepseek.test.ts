import type { LLMMessage, LLMRequest } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProviderClient } from './client.js';
import { createDeepSeekClient } from './deepseek.js';

const messages: LLMMessage[] = [
    {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        createdAt: 0,
    },
];

const req: LLMRequest = { messages };

describe('DeepSeek Provider（@mazi/provider）', () => {
    // 单元测试须在“无厂商 key”的确定性环境运行：屏蔽外部 DEEPSEEK_API_KEY，
    // 防止开发机/CI 导出 key 时误发真实请求（否则“缺 key → auth”断言依赖机器环境）。
    beforeAll(() => {
        vi.stubEnv('DEEPSEEK_API_KEY', '');
    });
    afterAll(() => {
        vi.unstubAllEnvs();
    });
    it('ask rejects with auth ProviderError when apiKey is missing', async () => {
        const client = createDeepSeekClient({ apiKey: '' });
        await expect(client.ask(req)).rejects.toMatchObject({ code: 'auth' });
    });

    it('askStream rejects with auth ProviderError when apiKey is missing', async () => {
        const client = createDeepSeekClient({ apiKey: '' });
        await expect(
            (async () => {
                for await (const _chunk of client.askStream(req)) {
                    // noop
                }
            })(),
        ).rejects.toMatchObject({ code: 'auth' });
    });

    it('ask fails fast on unknown model before network', async () => {
        const client = createDeepSeekClient({ apiKey: '' });
        await expect(client.ask({ ...req, model: 'not-a-model' })).rejects.toMatchObject({
            code: 'invalid_request',
        });
    });

    it('client 包装：wiring 层包 createProviderClient 后事件与 stats 在失败路径上工作', async () => {
        const events: string[] = [];
        const client = createProviderClient({
            provider: createDeepSeekClient({ apiKey: '' }),
            maxRetries: 0,
            onEvent: (event) => events.push(event.type),
        });
        await expect(client.ask(req)).rejects.toBeInstanceOf(ProviderError);
        expect(events).toContain('request');
        expect(events).toContain('error');
        expect(client.stats.requestCount).toBe(1);
        expect(client.stats.errorCount).toBe(1);
    });
});
