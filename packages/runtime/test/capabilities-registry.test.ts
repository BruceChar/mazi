/**
 * 注册表扫描 / 多根优先级 / 意图解析 / 不可变快照
 * （docs/能力包规范.md §7.1/§7.3、CP-1/CP-6）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    asSkillRoot,
    CapabilityRegistry,
    defaultBuiltinSkillsRoot,
    scaffoldSkill,
} from '../src/capabilities/index.js';
import { defaultManifest, defaultTool, writeSkillPackage } from './helpers/skill-package.js';

const dirs: string[] = [];

function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-skill-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function personal(id = 'alpha'): Record<string, unknown> {
    const manifest = defaultManifest(id);
    manifest.intents = { domains: ['personal'], categories: ['habit'], keywords: ['日记', '成就'] };
    return manifest;
}

function growth(): Record<string, unknown> {
    const manifest = defaultManifest('beta');
    manifest.intents = { domains: ['growth'], categories: ['mindset'], keywords: ['复盘'] };
    return manifest;
}

function toolNamed(name: string): Record<string, unknown> {
    return { ...defaultTool(), name };
}

/** 写一个自洽包（工具名与 id 绑定，避免跨包工具名冲突）。 */
function writePackage(root: string, id: string, manifest: Record<string, unknown>): void {
    writeSkillPackage(root, {
        id,
        manifest: { ...manifest, id, tools: [id + '.append'] },
        tools: { [id + '.append']: toolNamed(id + '.append') },
    });
}

describe('能力注册表：扫描 / 查询 / 快照', () => {
    it('list/get/has/errors 与不可变快照（冻结数组，改写抛错）', () => {
        const root = makeRoot();
        writePackage(root, 'alpha', personal());
        const registry = CapabilityRegistry.open({ roots: [asSkillRoot(root)] });
        expect(registry.roots).toHaveLength(1);
        expect(registry.errors()).toEqual([]);
        expect(registry.list().map((snapshot) => snapshot.manifest.id)).toEqual(['alpha']);
        expect(registry.get('nope')).toBeUndefined();
        expect(registry.has('alpha')).toBe(true);
        const snapshot = registry.get('alpha');
        expect(snapshot?.scope).toBe('user');
        expect(Object.isFrozen(snapshot?.tools)).toBe(true);
        expect(() => (snapshot?.tools as unknown[]).push({})).toThrow();
    });

    it('skills 根不存在 → 空注册表且不报错（用户尚未创建技能属正常态）', () => {
        const registry = CapabilityRegistry.open({
            roots: [asSkillRoot(join(makeRoot(), 'missing'))],
        });
        expect(registry.list()).toEqual([]);
        expect(registry.errors()).toEqual([]);
    });

    it('CP-6：新增第二个能力包无需改动注册表代码', () => {
        const root = makeRoot();
        writePackage(root, 'alpha', personal());
        writePackage(root, 'beta', growth());
        const registry = CapabilityRegistry.open({ roots: [asSkillRoot(root)] });
        expect(registry.errors()).toEqual([]);
        expect(registry.list().map((snapshot) => snapshot.manifest.id)).toEqual(['alpha', 'beta']);
    });

    it('三级优先：project > user > builtin（内置最低且只读）', () => {
        const project = makeRoot();
        const user = makeRoot();
        const builtin = makeRoot();
        writePackage(builtin, 'alpha', { ...personal(), version: '0.0.1' });
        writePackage(user, 'alpha', { ...personal(), version: '0.1.0' });
        writePackage(project, 'alpha', { ...personal(), version: '0.2.0' });
        writePackage(builtin, 'only-builtin', personal('only-builtin'));
        const registry = CapabilityRegistry.open({
            roots: [
                asSkillRoot(project, 'project'),
                asSkillRoot(user, 'user'),
                asSkillRoot(builtin, 'builtin'),
            ],
        });
        expect(registry.get('alpha')?.scope).toBe('project');
        expect(registry.get('alpha')?.manifest.version).toBe('0.2.0');
        expect(registry.get('only-builtin')?.scope).toBe('builtin');
        expect(registry.shadowed().map((entry) => entry.scope)).toEqual(['user', 'builtin']);
    });

    it('项目级优先：同名 id 以 project 覆盖 user，覆盖来源记入 shadowed()', () => {
        const project = makeRoot();
        const user = makeRoot();
        writePackage(user, 'alpha', personal());
        const projectManifest = { ...personal(), version: '0.2.0', name: '项目级技能' };
        writePackage(project, 'alpha', projectManifest);
        const registry = CapabilityRegistry.open({
            roots: [asSkillRoot(project, 'project'), asSkillRoot(user, 'user')],
        });
        expect(registry.errors()).toEqual([]);
        expect(registry.list()).toHaveLength(1);
        expect(registry.get('alpha')?.scope).toBe('project');
        expect(registry.get('alpha')?.manifest.version).toBe('0.2.0');
        expect(registry.shadowed()).toEqual([
            {
                skillId: 'alpha',
                dir: join(user, 'alpha'),
                scope: 'user',
                shadowedBy: join(project, 'alpha'),
            },
        ]);
    });
});

describe('CP-11 新建技能脚手架', () => {
    it('生成合法技能包（安全默认）并可被注册表加载', () => {
        const root = makeRoot();
        const skillRoot = asSkillRoot(root, 'user');
        const created = scaffoldSkill(skillRoot, {
            id: 'my-skill',
            name: '我的技能',
            description: '测试用技能',
        });
        expect(created.manifest.permissionCeiling).toBe('read-only');
        expect(created.manifest.tools).toEqual([]);
        const registry = CapabilityRegistry.open({ roots: [skillRoot] });
        expect(registry.errors()).toEqual([]);
        expect(registry.get('my-skill')?.manifest.name).toBe('我的技能');
    });

    it('非法 id / 已存在目录 / 内置只读根 → 拒绝', () => {
        const root = makeRoot();
        const skillRoot = asSkillRoot(root, 'user');
        scaffoldSkill(skillRoot, { id: 'my-skill', name: '我的技能' });
        expect(() => scaffoldSkill(skillRoot, { id: 'my-skill', name: '重复' })).toThrow();
        expect(() => scaffoldSkill(skillRoot, { id: 'Bad_Id', name: 'x' })).toThrow();
        expect(() => scaffoldSkill(skillRoot, { id: 'ok-id', name: '  ' })).toThrow();
        expect(() =>
            scaffoldSkill(asSkillRoot(root, 'builtin'), { id: 'ok-id', name: 'x' }),
        ).toThrow();
    });

    it('内置根默认落点为 runtime 包内的 builtin-skills', () => {
        expect(defaultBuiltinSkillsRoot()).toMatch(/builtin-skills$/);
    });
});

describe('意图解析（§7.3）', () => {
    function twoSkills(): CapabilityRegistry {
        const root = makeRoot();
        writePackage(root, 'alpha', personal());
        writePackage(root, 'beta', growth());
        return CapabilityRegistry.open({ roots: [asSkillRoot(root)] });
    }

    it('domain + category 命中优先（置信度归一）', () => {
        const match = twoSkills().resolveByIntent({
            speechAct: 'task',
            domains: ['personal'],
            categories: ['habit'],
        });
        expect(match?.skillId).toBe('alpha');
        expect(match?.confidence).toBe(1);
        expect(match?.reasons).toContain('domain:personal');
    });

    it('关键词命中为兜底（原文包含亦计入）', () => {
        const registry = twoSkills();
        expect(registry.resolveByIntent({ speechAct: 'task', keywords: ['复盘'] })?.skillId).toBe(
            'beta',
        );
        expect(registry.resolveByIntent({ speechAct: 'task', text: '今天想写日记' })?.skillId).toBe(
            'alpha',
        );
    });

    it('非 task/question 言说类型不参与路由', () => {
        expect(twoSkills().resolveByIntent({ speechAct: 'chitchat', text: '日记' })).toBeUndefined();
    });

    it('无命中 → undefined', () => {
        expect(
            twoSkills().resolveByIntent({ speechAct: 'task', domains: ['knowledge'] }),
        ).toBeUndefined();
    });

    it('并列命中 → resolveByIntent 返回 undefined，candidatesByIntent 给出候选', () => {
        const root = makeRoot();
        writePackage(root, 'alpha', personal());
        writePackage(root, 'gamma', personal('gamma'));
        const registry = CapabilityRegistry.open({ roots: [asSkillRoot(root)] });
        const query = { speechAct: 'task', domains: ['personal'], categories: ['habit'] } as const;
        expect(registry.resolveByIntent(query)).toBeUndefined();
        expect(registry.candidatesByIntent(query).map((match) => match.skillId)).toEqual([
            'alpha',
            'gamma',
        ]);
    });
});
