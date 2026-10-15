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
        // 内置根：随应用分发、只读（本用例用临时目录替代发行目录）
        process.env.MAZI_BUILTIN_SKILLS_DIR = join(h.home, 'builtin-skills');
        writeMinimalSkill(join(h.home, 'builtin-skills'), 'builtin-demo');
    });

    afterAll(async () => {
        await h.close();
        delete process.env.MAZI_BUILTIN_SKILLS_DIR;
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
        // 使用情况字段（发现 / 挂载 / 调用 / 校验失败）
        expect(body.usage).toEqual({
            discovered: 2,
            mounted: 0,
            invocations: 0,
            validationFailures: 0,
        });
        expect(demo?.usage).toEqual({ invocations: 0, validationFailures: 0 });
    });

    it('内置根技能可见且 scope=builtin（随应用分发、只读）', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/capabilities' });
        const builtin = skillIn(res.json(), 'builtin-demo');
        expect(builtin?.scope).toBe('builtin');
        expect((res.json().roots as Array<Record<string, unknown>>).at(-1)?.scope).toBe('builtin');
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

    it('POST /api/capabilities 新建技能 → 立即发现且落在 user 根；重名 409、builtin 400', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities',
            payload: { id: 'made-skill', name: '新建技能', description: '面板创建', scope: 'user' },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json().id).toBe('made-skill');
        expect(created.json().scope).toBe('user');
        expect(readFileSync(join(h.home, 'skills', 'made-skill', 'manifest.json'), 'utf8')).toContain(
            'made-skill',
        );

        const list = await h.fastify.inject({ method: 'GET', url: '/api/capabilities' });
        expect(skillIn(list.json(), 'made-skill')?.mounted).toBe(false);

        const duplicate = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities',
            payload: { id: 'made-skill', name: '重复' },
        });
        expect(duplicate.statusCode).toBe(409);

        const builtinCreate = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities',
            payload: { id: 'nope', name: 'x', scope: 'builtin' },
        });
        expect(builtinCreate.statusCode).toBe(400);

        const badId = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities',
            payload: { id: 'Bad_Id', name: 'x' },
        });
        expect(badId.statusCode).toBe(400);
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
