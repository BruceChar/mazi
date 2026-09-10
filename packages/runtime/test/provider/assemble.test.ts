import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentType, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleProviderStack } from '../../src/provider/assemble.js';
import type { ProviderConfig } from '../../src/provider/config.js';
import { FileProfileStore } from '../../src/provider/store.js';

const caps = {
    supportsToolCalls: true,
    supportsStreaming: true,
    inputTypes: ['text'] as ContentType[],
    outputTypes: ['text'] as ContentType[],
};

function fakeFauxProvider(id: string): LLMProvider {
    return {
        id,
        name: id,
        defaultModel: 'm1',
        models: [],
        async ask(_r: LLMRequest) {
            throw new ProviderError('unknown', 'unused');
        },
        async *askStream(_r: LLMRequest) {
            const events: StreamCompletionEvent[] = [
                { type: 'start', model: 'm1' },
                { type: 'text_delta', text: 'assembled ok' },
                { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
                { type: 'finish', finishReason: 'stop' },
            ];
            for (const event of events) yield event;
        },
    };
}

const configs: ProviderConfig[] = [
    {
        id: 'mock1',
        adapter: 'mock',
        models: [{ id: 'm1', capabilities: caps }],
    },
];
const fauxConfigs: ProviderConfig[] = [
    {
        id: 'faux1',
        adapter: 'faux',
        models: [{ id: 'm1', capabilities: caps }],
    },
];

let dir: string;
let store: FileProfileStore;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mazi-stack-'));
    store = new FileProfileStore(join(dir, 'profiles.json'));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('assembleProviderStack（§2 装配层，端到端离线）', () => {
    it('registry/supply/round 组装；离线一轮请求成功并产出 metrics/画像', async () => {
        const metrics: unknown[] = [];
        const stack = await assembleProviderStack({
            configs,
            adapters: { mock: (cfg) => fakeFauxProvider(cfg.id) },
            profileStore: store,
            onMetrics: (m) => metrics.push(m),
        });
        const entries = stack.supply.models();
        expect(entries).toHaveLength(1);
        expect(entries[0]?.health).toBe(100);
        expect(entries[0]?.breakerOpen).toBe(false);
        expect(entries[0]?.performance).toBeNull(); // 尚无样本
        const request: LLMRequest = {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        };
        const outcome = await stack.round.execute(request, [stack.candidate('mock1')]);
        expect(outcome.metrics.ok).toBe(true);
        expect(outcome.metrics.synthetic).toBeUndefined();
        expect(outcome.response.content).toEqual([{ type: 'text', text: 'assembled ok' }]);
        expect(metrics).toHaveLength(1);
        // 画像已实时更新
        const after = stack.supply.models()[0];
        expect(after?.performance?.sampleSize).toBe(1);
        // 画像快照落盘
        await stack.close();
        const saved = await store.load();
        expect(saved?.models['mock1/m1']?.performance.sampleSize).toBe(1);
    });

    it('faux：allowFaux=false 装配失败；allowFaux=true 时 synthetic 不入画像（§9.3）', async () => {
        await expect(
            assembleProviderStack({
                configs: fauxConfigs,
                adapters: { faux: (cfg) => fakeFauxProvider(cfg.id) },
            }),
        ).rejects.toThrow();
        const stack = await assembleProviderStack({
            configs: fauxConfigs,
            adapters: { faux: (cfg) => fakeFauxProvider(cfg.id) },
            allowFaux: true,
        });
        const request: LLMRequest = {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        };
        const outcome = await stack.round.execute(request, [stack.candidate('faux1')]);
        expect(outcome.metrics.synthetic).toBe(true);
        expect(stack.supply.models()[0]?.performance).toBeNull();
        await stack.close(); // 无 profileStore，无需断言
    });
});
