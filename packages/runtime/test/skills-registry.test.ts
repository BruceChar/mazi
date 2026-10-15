/**
 * Skill 注册表：三级根扫描 / 优先级 / 快照 / 装载错误（docs/能力包规范.md §4、CP SK-2）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSkillRoot, SkillRegistry } from '../src/capabilities/index.js';
import { writeSkill } from './helpers/skill.js';

const dirs: string[] = [];

function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-skills-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Skill 注册表：扫描与快照', () => {
    it('发现含 SKILL.md 的目录；随包文件进入 resources；快照冻结', () => {
        const root = makeRoot();
        writeSkill(root, 'demo', {
            frontmatter: { description: '演示技能' },
            resources: { 'references/format.md': '# 格式', 'scripts/run.sh': 'echo hi' },
        });
        const registry = SkillRegistry.open({ roots: [asSkillRoot(root)] });
        expect(registry.errors()).toEqual([]);
        expect(registry.list().map((snapshot) => snapshot.document.id)).toEqual(['demo']);
        const snapshot = registry.get('demo');
        expect(snapshot?.scope).toBe('user');
        expect(snapshot?.document.resources).toEqual(['references/format.md', 'scripts/run.sh']);
        expect(Object.isFrozen(snapshot?.document.resources)).toBe(true);
        expect(registry.has('ghost')).toBe(false);
    });

    it('目录缺少 SKILL.md → skill.missing，不进列表', () => {
        const root = makeRoot();
        mkdirSync(join(root, 'empty-dir'));
        const registry = SkillRegistry.open({ roots: [asSkillRoot(root)] });
        expect(registry.list()).toEqual([]);
        expect(registry.errors()[0]?.issues[0]?.code).toBe('skill.missing');
    });

    it('SKILL.md 非法（无 frontmatter）→ 报错且不进列表', () => {
        const root = makeRoot();
        writeSkill(root, 'broken', { raw: '# 没有 frontmatter' });
        const registry = SkillRegistry.open({ roots: [asSkillRoot(root)] });
        expect(registry.list()).toEqual([]);
        expect(registry.errors()[0]?.issues.map((issue) => issue.code)).toContain(
            'frontmatter.missing',
        );
    });

    it('三级优先：project > user > builtin，同名覆盖记入 shadowed()', () => {
        const project = makeRoot();
        const user = makeRoot();
        const builtin = makeRoot();
        writeSkill(builtin, 'demo', { frontmatter: { description: '内置' } });
        writeSkill(user, 'demo', { frontmatter: { description: '用户' } });
        writeSkill(project, 'demo', { frontmatter: { description: '项目' } });
        writeSkill(builtin, 'only-builtin', { frontmatter: { description: '只有内置' } });
        const registry = SkillRegistry.open({
            roots: [
                asSkillRoot(project, 'project'),
                asSkillRoot(user, 'user'),
                asSkillRoot(builtin, 'builtin'),
            ],
        });
        expect(registry.errors()).toEqual([]);
        expect(registry.get('demo')?.scope).toBe('project');
        expect(registry.get('demo')?.document.description).toBe('项目');
        expect(registry.get('only-builtin')?.scope).toBe('builtin');
        expect(registry.shadowed().map((entry) => entry.scope)).toEqual(['user', 'builtin']);
    });

    it('根不存在 → 空注册表且不报错', () => {
        const registry = SkillRegistry.open({ roots: [asSkillRoot(join(makeRoot(), 'missing'))] });
        expect(registry.list()).toEqual([]);
        expect(registry.errors()).toEqual([]);
    });
});
