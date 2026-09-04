import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LLMRequest, LLMStreamEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from './driver';
import type { ProviderJson } from './registry';
import { normalizeProvider, ScriptedDriverRegistry } from './registry';

const req: LLMRequest = {
    model: { providerId: 'scripted', vendor: 'scripted', modelId: 'm' },
    context: { messages: [], tools: [] },
};

async function collect(iterable: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
    const events: LLMStreamEvent[] = [];
    for await (const event of iterable) {
        events.push(event);
    }
    return events;
}

const simpleModel = {
    id: 'm',
    contextWindow: 1_000,
    supportsTools: false,
    supportsThinking: false,
    supportsVision: false,
};

describe('registry（MVP v1.0 §8 F5）', () => {
    it('normalizeProvider 补齐全部默认：performance/economics/pricing/health/costWeight', () => {
        const json: ProviderJson = { id: 'scripted-a', vendor: 'scripted', models: [] };
        const provider = normalizeProvider(json);
        // pricing 默认
        expect(provider.pricing.currency).toBe('USD');
        expect(provider.pricing.base).toEqual({ inputPerMTok: 1, outputPerMTok: 3 });
        expect(provider.pricing.tiers).toEqual([]);
        expect(provider.pricing.version).toBe('0.0.0');
        const now = Date.now();
        expect(provider.pricing.effectiveAt).toBeGreaterThanOrEqual(now - 1_000);
        expect(provider.pricing.effectiveAt).toBeLessThanOrEqual(now);
        // 画像 / 经济 / 健康 / 权重默认
        expect(provider.performance.sampleSize).toBe(0);
        expect(provider.economics.sampleSize).toBe(0);
        expect(provider.health).toEqual({ score: 1 });
        expect(provider.costWeight).toBe(1);
        expect(provider.tags).toEqual([]);
        expect(provider.specialties).toEqual([]);
        expect(provider.limits).toEqual({});
        // performance 内部结构可用（p50/p90/p95 齐备）
        expect(provider.performance.tokensPerSecond.p50).toBe(0);
        expect(provider.performance.tokensPerSecond.p99).toBeUndefined();
    });

    it('normalizeProvider 保留显式配置（pricing.base/tiers/health/costWeight/tags/specialties）', () => {
        const json: ProviderJson = {
            id: 'scripted-b',
            vendor: 'scripted',
            tags: ['tools', 'long-context'],
            specialties: ['code-refactoring'],
            models: [simpleModel],
            pricing: {
                base: { inputPerMTok: 0.5, outputPerMTok: 1.5, cacheReadPerMTok: 0.1 },
                tiers: [
                    {
                        name: 'off-peak',
                        windowHoursUtc: [0, 8],
                        multiplier: 0.5,
                        appliesTo: ['input'],
                    },
                ],
                effectiveAt: 1_700_000_000_000,
                version: '0.1.0',
            },
            health: { score: 0.8, lastErrorAt: 42 },
            costWeight: 0.7,
        };
        const provider = normalizeProvider(json);
        expect(provider.pricing.base).toEqual({
            inputPerMTok: 0.5,
            outputPerMTok: 1.5,
            cacheReadPerMTok: 0.1,
        });
        expect(provider.pricing.tiers).toHaveLength(1);
        expect(provider.pricing.tiers[0]?.multiplier).toBe(0.5);
        expect(provider.pricing.effectiveAt).toBe(1_700_000_000_000);
        expect(provider.pricing.version).toBe('0.1.0');
        expect(provider.health).toEqual({ score: 0.8, lastErrorAt: 42 });
        expect(provider.costWeight).toBe(0.7);
        expect(provider.tags).toEqual(['tools', 'long-context']);
        expect(provider.specialties).toEqual(['code-refactoring']);
    });

    it('ScriptedDriverRegistry.build 用 driver.rounds 构造驱动并支持 failCalls', async () => {
        const json: ProviderJson = {
            id: 'p',
            vendor: 'scripted',
            models: [simpleModel],
            driver: {
                type: 'scripted',
                rounds: [{ text: 'R1' }, { text: 'R2' }],
                failCalls: 1,
            },
        };
        const provider = normalizeProvider(json);
        const driver = new ScriptedDriverRegistry().build(provider, json);
        expect(driver).toBeInstanceOf(ScriptedDriver);
        expect(() => driver.stream(req)).toThrow('scripted-fail');
        expect(await collect(driver.stream(req))).toContainEqual({
            type: 'text-delta',
            delta: 'R1',
        });
        expect(await collect(driver.stream(req))).toContainEqual({
            type: 'text-delta',
            delta: 'R2',
        });
    });

    it('ScriptedDriverRegistry.build 读取 scenarioFile（相对 cwd）并应用文件 failCalls', async () => {
        const scenarioFile = relative(
            process.cwd(),
            fileURLToPath(new URL('./fixtures/scenario-sample.json', import.meta.url)),
        );
        const json: ProviderJson = {
            id: 'scn',
            vendor: 'scripted',
            models: [simpleModel],
            driver: { type: 'scripted', scenarioFile },
        };
        const driver = new ScriptedDriverRegistry().build(normalizeProvider(json), json);
        // scenarioFile.failCalls=1 生效
        expect(() => driver.stream(req)).toThrow('scripted-fail');
        expect(await collect(driver.stream(req))).toContainEqual({
            type: 'text-delta',
            delta: 'scenario-first-round',
        });
        const second = await collect(driver.stream(req));
        expect(second).toContainEqual({ type: 'text-delta', delta: 'scenario-second-round' });
        expect(second).toContainEqual({
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 5, reportedByVendor: true },
        });
    });

    it('driver 配置异常：非 scripted 类型 / scenarioFile 缺失均抛错', () => {
        const badType = {
            id: 'bad',
            vendor: 'v',
            models: [],
            driver: { type: 'openai', rounds: [{ text: 'x' }] },
        } as unknown as ProviderJson;
        expect(() =>
            new ScriptedDriverRegistry().build(normalizeProvider(badType), badType),
        ).toThrow(/openai/);
        const missingFile: ProviderJson = {
            id: 'missing',
            vendor: 'v',
            models: [],
            driver: { scenarioFile: 'packages/provider-llm/src/fixtures/__not-exists__.json' },
        };
        expect(() =>
            new ScriptedDriverRegistry().build(normalizeProvider(missingFile), missingFile),
        ).toThrow(/scenarioFile/);
    });
});
