import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, StreamCompletionEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { CatalogService, MemoryCatalogStore, type ObservedCatalog } from '../src/catalog/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/runtime.js';

function usageProvider(): LLMProvider {
    return {
        id: 'default',
        name: 'default',
        defaultModel: 'faux-model',
        models: [],
        async ask() {
            throw new Error('ask unused in catalog usage loop test');
        },
        async *askStream(): AsyncIterable<StreamCompletionEvent> {
            yield { type: 'start', model: 'faux-model' };
            yield { type: 'text_delta', text: 'hi' };
            yield {
                type: 'usage',
                usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
            };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

const OBSERVED: ObservedCatalog = {
    providers: [
        {
            id: 'default',
            displayName: 'default',
            driverType: 'pi-ai',
            models: [
                {
                    id: 'faux-model',
                    name: 'faux',
                    vendor: { id: 'faux' },
                    capabilities: {
                        contextWindow: 64000,
                        maxTokens: 8192,
                        supportsThinking: true,
                        supportsTools: false,
                        supportsVision: false,
                    },
                    pricing: {
                        currency: 'USD',
                        base: { inputPerMTok: 1, outputPerMTok: 2 },
                        version: 'v1',
                    },
                },
            ],
        },
    ],
};

describe('catalog 凭证闭环：运行时 usage → UsageRecord', () => {
    it('接入目录后每轮 usage 按钉死的 plan/epoch 追加账本凭证', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-catloop-'));
        try {
            const catalog = await CatalogService.open({
                store: new MemoryCatalogStore(),
                now: () => 1000,
            });
            await catalog.sync(OBSERVED, { now: 1000 });
            const config: RuntimeConfig = {
                providers: [],
                tools: [],
                dbPath: ':memory:',
                eventDir: dir,
                goal: { allowedTools: [], permissionCeiling: 'read-only' },
                contextWindow: 64000,
            };
            const runtime = new HarnessRuntime(config, {
                llmProviders: { default: usageProvider() },
            });
            runtime.setCatalog(catalog);
            try {
                const created = await runtime.createGoalSession('你好');
                await runtime.executeGoalTree(created.rootGoalId);
                const records = await catalog.usageRecords();
                expect(records).toHaveLength(1);
                expect(records[0]?.offeringId).toBe('default/faux-model');
                expect(records[0]?.modelId).toBe('faux-model');
                expect(records[0]?.providerId).toBe('default');
                expect(records[0]?.catalogEpoch).toBe(1);
                expect(records[0]?.inputTokens).toBe(1_000_000);
                expect(records[0]?.outputTokens).toBe(500_000);
                expect(records[0]?.cost).toBeCloseTo(2, 10);
            } finally {
                await runtime.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('未接入目录时执行照常，不产生凭证', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-catloop-'));
        try {
            const catalog = await CatalogService.open({ store: new MemoryCatalogStore() });
            const config: RuntimeConfig = {
                providers: [],
                tools: [],
                dbPath: ':memory:',
                eventDir: dir,
                goal: { allowedTools: [], permissionCeiling: 'read-only' },
            };
            const runtime = new HarnessRuntime(config, {
                llmProviders: { default: usageProvider() },
            });
            try {
                const created = await runtime.createGoalSession('你好');
                await runtime.executeGoalTree(created.rootGoalId);
                expect(await catalog.usageRecords()).toHaveLength(0);
            } finally {
                await runtime.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
