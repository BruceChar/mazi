/**
 * Skill 发现 / 新建 / 挂载 / 卸载接口（docs/能力包规范.md §6、CP SK-6）。
 * Skill 是用户资产：用例把 <id>/SKILL.md 写进 $MAZI_HOME/skills 后调用 reload 发现。
 */

import 'reflect-metadata';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

/** 最小 Skill：一个目录 + SKILL.md。 */
function writeSkill(skillsDir: string, id: string, description: string): void {
    const dir = join(skillsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'SKILL.md'),
        ['---', 'name: ' + id, 'description: ' + description, '---', '', '# ' + id, '', '照做即可。', ''].join('\n'),
        'utf8',
    );
}

function skillIn(body: Record<string, unknown>, id: string): Record<string, unknown> | undefined {
    return (body.skills as Array<Record<string, unknown>>).find((skill) => skill.id === id);
}

describe('Skill 管理接口（§6 / CP SK-6）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
        writeSkill(join(h.home, 'skills'), 'demo', '演示：写日记');
        process.env.MAZI_BUILTIN_SKILLS_DIR = join(h.home, 'builtin-skills');
        writeSkill(join(h.home, 'builtin-skills'), 'builtin-demo', '内置演示');
        mkdirSync(join(h.home, 'skills', 'no-skill-md'), { recursive: true });
    });

    afterAll(async () => {
        await h.close();
        delete process.env.MAZI_BUILTIN_SKILLS_DIR;
    });

    it('POST reload → 列出 Skill（scope/usage/路径）与内置根，缺失 SKILL.md 进 errors', async () => {
        const res = await h.fastify.inject({ method: 'POST', url: '/api/capabilities/reload' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.roots[0].scope).toBe('project');
        expect(body.roots.at(-1).scope).toBe('builtin');

        const demo = skillIn(body, 'demo');
        expect(demo?.scope).toBe('user');
        expect(demo?.mounted).toBe(false);
        expect(demo?.description).toBe('演示：写日记');
        expect((demo?.path as string).endsWith(join('demo', 'SKILL.md'))).toBe(true);
        expect(demo?.usage).toEqual({ injections: 0 });

        expect(skillIn(body, 'builtin-demo')?.scope).toBe('builtin');
        expect((body.errors as Array<Record<string, unknown>>).map((e) => e.skillId)).toContain(
            'no-skill-md',
        );
        expect(body.usage.discovered).toBe(2);
    });

    it('GET 详情返回正文与 frontmatter；未知 id → 404', async () => {
        const detail = await h.fastify.inject({ method: 'GET', url: '/api/capabilities/demo' });
        expect(detail.statusCode).toBe(200);
        const body = detail.json();
        expect(body.body).toContain('照做即可');
        expect(body.frontmatter.name).toBe('demo');
        expect(body.frontmatter.description).toBe('演示：写日记');
        expect(body.resources).toEqual([]);

        const ghost = await h.fastify.inject({ method: 'GET', url: '/api/capabilities/ghost' });
        expect(ghost.statusCode).toBe(404);
    });

    it('挂载 → mounted=true 且落 skills.json；卸载 → false（幂等）', async () => {
        const mount = await h.fastify.inject({ method: 'POST', url: '/api/capabilities/demo/mount' });
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

    it('POST 新建 Skill → 写 SKILL.md 并立即发现；重名 409、builtin 400、非法 id 400', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/capabilities',
            payload: { id: 'made-skill', name: '新建技能', description: '面板创建', scope: 'user' },
        });
        expect(created.statusCode).toBe(200);
        expect(created.json().id).toBe('made-skill');
        const file = join(h.home, 'skills', 'made-skill', 'SKILL.md');
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf8')).toContain('description: 面板创建');

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
});
