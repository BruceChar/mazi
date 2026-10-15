/**
 * Feature 开关接口（docs/AB测试设计.md §8.1、AB-2/AB-11）。
 * 定义落 $MAZI_HOME/features.json；开关只影响提示/技能/工具面。
 */

import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('Feature 开关接口', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
    });

    afterAll(async () => {
        await h.close();
    });

    it('初始为空；POST 新建 → 落 features.json 且立即可见', async () => {
        const empty = await h.fastify.inject({ method: 'GET', url: '/api/features' });
        expect(empty.statusCode).toBe(200);
        expect(empty.json()).toMatchObject({ features: [], summary: { total: 0, enabled: 0 } });

        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/features',
            payload: {
                id: 'concise',
                name: '简洁作答',
                description: '先给结论',
                promptFragment: '先给结论，再给理由。',
                skills: ['demo-skill'],
                skillMode: 'add',
                allowedTools: ['fs.read', 'rg'],
                reasoningLevel: 'low',
            },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json()).toMatchObject({ id: 'concise', enabled: false });

        const file = join(h.home, 'features.json');
        const persisted = JSON.parse(readFileSync(file, 'utf8')) as { features: unknown[] };
        expect(persisted.features).toHaveLength(1);

        const list = await h.fastify.inject({ method: 'GET', url: '/api/features' });
        expect(list.json().summary).toEqual({ total: 1, enabled: 0, ids: ['concise'] });
    });

    it('重复 id → 409；非法 id → 400', async () => {
        const duplicate = await h.fastify.inject({
            method: 'POST',
            url: '/api/features',
            payload: { id: 'concise', name: '重复', description: 'd' },
        });
        expect(duplicate.statusCode).toBe(409);

        const bad = await h.fastify.inject({
            method: 'POST',
            url: '/api/features',
            payload: { id: 'Bad_Id', name: 'x', description: 'd' },
        });
        expect(bad.statusCode).toBe(400);
    });

    it('GET/PATCH/DELETE 单条：开关切换、清空字段、404', async () => {
        const detail = await h.fastify.inject({ method: 'GET', url: '/api/features/concise' });
        expect(detail.json().promptFragment).toBe('先给结论，再给理由。');

        const toggled = await h.fastify.inject({
            method: 'PATCH',
            url: '/api/features/concise',
            payload: { enabled: true, allowedTools: null },
        });
        expect(toggled.statusCode).toBe(200);
        expect(toggled.json()).toMatchObject({ enabled: true });
        expect(toggled.json().allowedTools).toBeUndefined();

        const missing = await h.fastify.inject({
            method: 'PATCH',
            url: '/api/features/ghost',
            payload: { enabled: true },
        });
        expect(missing.statusCode).toBe(404);

        const removed = await h.fastify.inject({ method: 'DELETE', url: '/api/features/concise' });
        expect(removed.json()).toEqual({ ok: true, removed: true });
        const gone = await h.fastify.inject({ method: 'GET', url: '/api/features/concise' });
        expect(gone.statusCode).toBe(404);
    });

    it('POST resolve：给定 override 的解析预览（含 trace 与来源）', async () => {
        await h.fastify.inject({
            method: 'POST',
            url: '/api/features',
            payload: {
                id: 'concise',
                name: '简洁',
                description: 'd',
                promptFragment: '简洁作答',
            },
        });
        const resolved = await h.fastify.inject({
            method: 'POST',
            url: '/api/features/resolve',
            payload: { overrides: { concise: true } },
        });
        const body = resolved.json();
        expect(body.enabledIds).toEqual(['concise']);
        expect(body.promptFragment).toBe('简洁作答');
        expect(body.trace).toEqual([{ id: 'concise', enabled: true, source: 'override' }]);
    });

    it('features.json 损坏 → 降级为空集合（不阻断接口）', async () => {
        writeFileSync(join(h.home, 'features.json'), '{ broken', 'utf8');
        const reloaded = await createTestApp();
        try {
            const list = await reloaded.fastify.inject({ method: 'GET', url: '/api/features' });
            expect(list.statusCode).toBe(200);
            expect(list.json().summary.total).toBe(0);
        } finally {
            await reloaded.close();
        }
    });
});
