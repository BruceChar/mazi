import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

function providersJson(inputPerMTok: number, version: string): { providers: unknown[] } {
    return {
        providers: [
            {
                id: 'deepseek',
                vendor: 'deepseek',
                tags: ['official'],
                models: [
                    {
                        id: 'deepseek-v4-flash',
                        name: 'V4 Flash',
                        contextWindow: 128000,
                        supportsTools: true,
                        supportsThinking: true,
                        supportsVision: false,
                    },
                    { id: 'deepseek-v4-pro', contextWindow: 256000, supportsTools: true },
                ],
                driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-v4-flash' },
                pricing: {
                    currency: 'USD',
                    base: { inputPerMTok, outputPerMTok: 2 },
                    tiers: [],
                    effectiveAt: 0,
                    version,
                },
            },
        ],
    };
}

describe('catalog API（模型目录与计费数据架构）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
        writeFileSync(join(h.home, 'providers.json'), JSON.stringify(providersJson(1, 'catalog-v1')));
    });

    afterAll(async () => {
        await h.close();
    });

    it('GET /api/catalog/snapshot 惰性 bootstrap：offering 级目录，默认型号有价、其余无价', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/catalog/snapshot' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.epoch).toBe(1);
        expect(body.offerings).toHaveLength(2);
        const flash = body.offerings.find(
            (item: { offering: { id: string } }) =>
                item.offering.id === 'deepseek/deepseek-v4-flash',
        );
        const pro = body.offerings.find(
            (item: { offering: { id: string } }) => item.offering.id === 'deepseek/deepseek-v4-pro',
        );
        expect(flash.pricing.version).toBe('catalog-v1');
        expect(flash.effectiveCapabilities.supportsTools).toBe(true);
        expect(pro.pricing).toBeNull();
    });

    it('GET /api/catalog/driver-configs 返回 bootstrap 写入的默认绑定', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/catalog/driver-configs' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.configs[0].id).toBe('default');
        expect(body.configs[0].offeringId).toBe('deepseek/deepseek-v4-flash');
    });

    it('POST /api/catalog/sync 无 diff 幂等；调价后 changed=true 且 epoch+1', async () => {
        const first = await h.fastify.inject({ method: 'POST', url: '/api/catalog/sync' });
        expect(first.statusCode).toBe(200);
        expect(first.json().changed).toBe(false);

        writeFileSync(join(h.home, 'providers.json'), JSON.stringify(providersJson(3, 'catalog-v2')));
        const second = await h.fastify.inject({ method: 'POST', url: '/api/catalog/sync' });
        expect(second.json().changed).toBe(true);
        expect(second.json().epoch).toBe(2);

        const snapshot = await h.fastify.inject({ method: 'GET', url: '/api/catalog/snapshot' });
        const flash = snapshot.json().offerings.find(
            (item: { offering: { id: string } }) =>
                item.offering.id === 'deepseek/deepseek-v4-flash',
        );
        expect(flash.pricing.version).toBe('catalog-v2');
        expect(flash.pricing.base.inputPerMTok).toBe(3);
    });

    it('GET /api/catalog/changes?since=0 返回追加审计（价格变更 + 来源 operator）', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/catalog/changes?since=0' });
        expect(res.statusCode).toBe(200);
        const kinds = res.json().changes.map((change: { kind: string }) => change.kind);
        expect(kinds).toContain('pricing-changed');
        const pricing = res
            .json()
            .changes.find(
                (change: { kind: string; epoch: number }) =>
                    change.kind === 'pricing-changed' && change.epoch === 2,
            );
        expect(pricing.source).toBe('operator');
    });

    it('GET /api/catalog/usage 与 summary：账本只读、append-only（初始为空）', async () => {
        const usage = await h.fastify.inject({ method: 'GET', url: '/api/catalog/usage' });
        expect(usage.statusCode).toBe(200);
        expect(usage.json().records).toEqual([]);
        const summary = await h.fastify.inject({ method: 'GET', url: '/api/catalog/usage/summary' });
        expect(summary.statusCode).toBe(200);
        expect(summary.json().totals.records).toBe(0);
    });

    it('POST /api/catalog/driver-configs 写入迁移链', async () => {
        const res = await h.fastify.inject({
            method: 'POST',
            url: '/api/catalog/driver-configs',
            payload: {
                id: 'default',
                offeringId: 'deepseek/deepseek-v4-flash',
                fallbackOfferingIds: ['deepseek/deepseek-v4-pro'],
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().configs[0].fallbackOfferingIds).toEqual(['deepseek/deepseek-v4-pro']);
    });

    it('POST /api/catalog/aliases 登记改名 alias，并在审计中留痕', async () => {
        const res = await h.fastify.inject({
            method: 'POST',
            url: '/api/catalog/aliases',
            payload: {
                oldModelId: 'deepseek-v4-pro',
                canonicalModelId: 'deepseek-v4-flash',
                reason: 'vendor-rename',
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().alias.reason).toBe('vendor-rename');
        const changes = await h.fastify.inject({ method: 'GET', url: '/api/catalog/changes' });
        const aliasChange = changes
            .json()
            .changes.find((change: { kind: string }) => change.kind === 'alias-created');
        expect(aliasChange.payload.oldModelId).toBe('deepseek-v4-pro');
    });

    it('POST /api/catalog/aliases 非法 body → 400', async () => {
        const res = await h.fastify.inject({
            method: 'POST',
            url: '/api/catalog/aliases',
            payload: { oldModelId: 'x' },
        });
        expect(res.statusCode).toBe(400);
    });
});
