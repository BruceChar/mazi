/**
 * CP-10：技能发现与挂载/卸载接口（docs/能力包规范.md §10）。
 * 技能是用户资产：用例把技能包写进 $MAZI_HOME/skills 后调用 reload 发现。
 */

import 'reflect-metadata';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

/** 最小合法技能包（仅 manifest）：API 管理面测试用。 */
function writeMinimalSkill(skillsDir: string, id: string): void {
    const dir = join(skillsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify(
            {
                id,
                version: '0.1.0',
                name: '演示技能 ' + id,
                description: '最小技能包',
                intents: {
                    domains: ['personal'],
                    categories: ['habit'],
                    keywords: ['演示'],
                },
                permissionCeiling: 'draft',
                tools: [],
                memory: { collections: [] },
                templates: [],
                validators: [],
                events: { emits: [], subscribes: [] },
            },
            null,
            2,
        ),
    );
}

function skillIn(body: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
    return (body.skills as Array<Record<string, unknown>>).find((skill) => skill.id === id);
}

describe('技能发现与挂载/卸载（§10 / CP-10）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
        writeMinimalSkill(join(h.home, 'skills'), 'demo');
    });

    afterAll(async () => {
        await h.close();
    });

    it('POST /api/capabilities/reload → 列表可见（user 作用域 / 未挂载 / 无装载错误）', async () => {
        const res = await h.fastify.inject({ method: 'POST', url: '/api/capabilities/reload' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.errors).toEqual([]);
        expect(body.roots[0].scope).toBe('project');
        const demo = skillIn(body, 'demo');
        expect(demo?.scope).toBe('user');
        expect(demo?.mounted).toBe(false);
        expect(demo?.permissionCeiling).toBe('draft');
    });

    it('挂载 → mounted=true 且落 skills.json；卸载 → mounted=false（幂等）', async () => {
        const mount = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities/demo/mount',
        });
        expect(mount.statusCode).toBe(200);
        expect(mount.json().mounted).toBe(true);
        expect(JSON.parse(readFileSync(join(h.home, 'skills.json'), 'utf8'))).toEqual({
            mounted: ['demo'],
        });

        const list = await h.fastify.inject({ method: 'GET', url: '/api/capabilities' });
        expect(skillIn(list.json(), 'demo')?.mounted).toBe(true);

        const unmount = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities/demo/unmount',
        });
        expect(unmount.json()).toEqual({ ok: true, unmounted: true, mounted: [] });
        const again = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities/demo/unmount',
        });
        expect(again.json().unmounted).toBe(false);
    });

    it('GET /api/capabilities/:id → manifest 全量；未知 id / 挂载未知技能 → 404', async () => {
        const detail = await h.fastify.inject({ method: 'GET', url: '/api/capabilities/demo' });
        expect(detail.statusCode).toBe(200);
        const body = detail.json();
        expect(body.id).toBe('demo');
        expect(body.tools).toEqual([]);
        expect(body.memory.collections).toEqual([]);
        expect(body.events.emits).toEqual([]);

        const ghost = await h.fastify.inject({ method: 'GET', url: '/api/capabilities/ghost' });
        expect(ghost.statusCode).toBe(404);
        const ghostMount = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities/ghost/mount',
        });
        expect(ghostMount.statusCode).toBe(404);
    });

    it('非法 manifest 只进 errors()，不进入可挂载列表', async () => {
        const badDir = join(h.home, 'skills', 'bad');
        mkdirSync(badDir, { recursive: true });
        writeFileSync(
            join(badDir, 'manifest.json'),
            JSON.stringify({ id: 'bad', version: 'not-semver' }, null, 2),
        );
        const res = await h.fastify.inject({ method: 'POST', url: '/api/capabilities/reload' });
        const body = res.json();
        expect(skillIn(body, 'bad')).toBeUndefined();
        const error = (body.errors as Array<Record<string, unknown>>).find(
            (entry) => entry.skillId === 'bad',
        );
        expect(error?.scope).toBe('user');
        expect((error?.issues as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    });
});
