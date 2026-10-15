/**
 * SkillRuntime：挂载状态 / catalog 注入 / 使用情况 / 新建脚手架
 * （docs/能力包规范.md §3/§5/§6、CP SK-3/SK-4）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    asSkillRoot,
    defaultBuiltinSkillsRoot,
    FileSkillMountStore,
    MemorySkillMountStore,
    scaffoldSkill,
    SkillRegistry,
    SkillRuntime,
} from '../src/capabilities/index.js';
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

function runtimeWith(root: string, state?: MemorySkillMountStore | FileSkillMountStore): SkillRuntime {
    const registry = SkillRegistry.open({ roots: [asSkillRoot(root)] });
    return new SkillRuntime({ registry, state: state ?? new MemorySkillMountStore() });
}

describe('挂载状态', () => {
    it('挂载写入 skills.json，新实例 init() 后保持；卸载写回空表', async () => {
        const root = makeRoot();
        writeSkill(root, 'demo');
        const stateFile = join(makeRoot(), 'skills.json');
        const state = new FileSkillMountStore(stateFile);

        const first = runtimeWith(root, state);
        await first.init();
        expect(first.list()[0]?.mounted).toBe(false);
        await first.mount('demo');
        expect(first.isMounted('demo')).toBe(true);
        expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ mounted: ['demo'] });

        const second = runtimeWith(root, state);
        await second.init();
        expect(second.mounted()).toEqual(['demo']);

        await second.unmount('demo');
        expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ mounted: [] });
    });

    it('挂载/卸载幂等；未知或未通过校验的 Skill 拒绝挂载', async () => {
        const root = makeRoot();
        writeSkill(root, 'demo');
        const runtime = runtimeWith(root);
        await runtime.init();
        await expect(runtime.mount('ghost')).rejects.toThrow();
        await runtime.mount('demo');
        await runtime.mount('demo');
        expect(runtime.mounted()).toEqual(['demo']);
        expect(await runtime.unmount('demo')).toBe(true);
        expect(await runtime.unmount('demo')).toBe(false);
    });
});

describe('渐进披露：catalog 与使用情况', () => {
    it('未挂载不进 catalog；挂载后只含 name/description/path；同 run 去重、跨 run 累加', async () => {
        const root = makeRoot();
        writeSkill(root, 'demo', { frontmatter: { description: '演示：写日记' } });
        const runtime = runtimeWith(root);
        await runtime.init();
        expect(runtime.catalog({ rootGoalId: 'run-1' })).toEqual([]);

        await runtime.mount('demo');
        const catalog = runtime.catalog({ rootGoalId: 'run-1' });
        expect(catalog).toHaveLength(1);
        expect(catalog[0]?.name).toBe('demo');
        expect(catalog[0]?.description).toBe('演示：写日记');
        expect(catalog[0]?.path.endsWith(join('demo', 'SKILL.md'))).toBe(true);
        expect(catalog[0]).not.toHaveProperty('body');

        runtime.catalog({ rootGoalId: 'run-1' });
        expect(runtime.usageOf('demo').injections).toBe(1);
        runtime.catalog({ rootGoalId: 'run-2' });
        expect(runtime.usageOf('demo').injections).toBe(2);
        expect(runtime.usageSummary()).toEqual({ discovered: 1, mounted: 1, injections: 2 });
    });

    it('详情返回正文 / frontmatter / 随包文件；instructions 取正文', async () => {
        const root = makeRoot();
        writeSkill(root, 'demo', {
            body: '# 演示\n\n照做即可',
            frontmatter: { when_to_use: '用户提到演示', allowed_tools: 'fs.read' },
            resources: { 'references/x.md': 'x' },
        });
        const runtime = runtimeWith(root);
        await runtime.init();
        const detail = runtime.detail('demo');
        expect(detail?.body).toBe('# 演示\n\n照做即可');
        expect(detail?.frontmatter.whenToUse).toBe('用户提到演示');
        expect(detail?.allowedTools).toEqual(['fs.read']);
        expect(detail?.resources).toEqual(['references/x.md']);
        expect(runtime.instructions('demo')).toContain('照做即可');
        expect(runtime.detail('ghost')).toBeUndefined();
    });
});

describe('新建 Skill', () => {
    it('主体分栏拼装正文：何时使用 / 步骤（编号）/ 输出 / 注意事项', async () => {
        const root = makeRoot();
        const skillRoot = asSkillRoot(root, 'user');
        const created = scaffoldSkill(skillRoot, {
            id: 'my-skill',
            name: '我的技能',
            description: '做某事；当用户要求做某事时使用',
            whenToUse: '用户说「帮我做某事」\n用户上传了相关文件',
            steps: '- 读取 references/format.md\n向用户确认范围\n2. 写入结果文件',
            output: '结果文件路径\n三条要点',
            notes: '不写入公开目录',
        });
        expect(existsSync(created.path)).toBe(true);
        expect(created.content.startsWith('---')).toBe(true);
        expect(created.content).toContain('## 何时使用');
        expect(created.content).toContain('- 用户说「帮我做某事」');
        expect(created.content).toContain('## 步骤');
        expect(created.content).toContain('1. 读取 references/format.md');
        expect(created.content).toContain('2. 向用户确认范围');
        expect(created.content).toContain('3. 写入结果文件');
        expect(created.content).toContain('## 输出');
        expect(created.content).toContain('- 结果文件路径');
        expect(created.content).toContain('## 注意事项');
        expect(created.content).toContain('- 不写入公开目录');

        const registry = SkillRegistry.open({ roots: [skillRoot] });
        expect(registry.errors()).toEqual([]);
        expect(registry.get('my-skill')?.document.description).toBe('做某事；当用户要求做某事时使用');
        expect(registry.get('my-skill')?.document.body).toContain('## 步骤');
    });

    it('分栏全空 → 落占位骨架，仍是合法 SKILL.md', () => {
        const root = makeRoot();
        const created = scaffoldSkill(asSkillRoot(root, 'user'), { id: 'blank', name: '空白技能' });
        expect(created.content).toContain('## 何时使用');
        expect(created.content).toContain('（写清触发场景与典型请求');
        expect(created.content).toContain('1. …');
        const registry = SkillRegistry.open({ roots: [asSkillRoot(root, 'user')] });
        expect(registry.errors()).toEqual([]);
        expect(registry.get('blank')).toBeDefined();
    });

    it('非法 id / 已存在 / 内置只读根 → 拒绝', () => {
        const root = makeRoot();
        const skillRoot = asSkillRoot(root, 'user');
        scaffoldSkill(skillRoot, { id: 'my-skill', name: '我的技能' });
        expect(() => scaffoldSkill(skillRoot, { id: 'my-skill', name: '重复' })).toThrow();
        expect(() => scaffoldSkill(skillRoot, { id: 'Bad_Id', name: 'x' })).toThrow();
        expect(() => scaffoldSkill(skillRoot, { id: 'ok-id', name: '  ' })).toThrow();
        expect(() => scaffoldSkill(asSkillRoot(root, 'builtin'), { id: 'ok-id', name: 'x' })).toThrow();
    });

    it('内置根默认落点为 runtime 包内的 builtin-skills', () => {
        expect(defaultBuiltinSkillsRoot()).toMatch(/builtin-skills$/);
    });
});
