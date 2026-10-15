/**
 * CP-1：注册表加载 —— 启动扫描 + 机械校验（docs/能力包规范.md §5 / §13 CP-1）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillValidationIssueCode } from '@mazi/core';
import { asSkillRoot, CapabilityRegistry } from '../src/capabilities/index.js';
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

function open(root: string): CapabilityRegistry {
    return CapabilityRegistry.open({ roots: [asSkillRoot(root)] });
}

function codesFor(registry: CapabilityRegistry, skillId: string): SkillValidationIssueCode[] {
    return registry
        .errors()
        .filter((error) => error.skillId === skillId)
        .flatMap((error) => error.issues.map((issue) => issue.code));
}

describe('CP-1 机械校验：合法能力包', () => {
    it('完整 skill 包加载成功并构建快照（工具/模板/校验器/记忆 schema）', () => {
        const root = makeRoot();
        writeSkillPackage(root, { id: 'demo' });
        const registry = open(root);
        expect(registry.errors()).toEqual([]);
        const snapshot = registry.get('demo');
        expect(snapshot).toBeDefined();
        expect(snapshot?.tools.map((tool) => tool.name)).toEqual(['demo.append']);
        expect([...(snapshot?.templates.keys() ?? [])]).toEqual(['demo-prompt']);
        expect([...(snapshot?.validators.keys() ?? [])]).toEqual(['entry']);
        expect([...(snapshot?.memorySchemas.keys() ?? [])]).toEqual(['entries']);
        expect(snapshot?.eventsModule).toBe('./events.ts');
    });
});

describe('CP-1 机械校验：非法能力包被拒绝并报错', () => {
    it('manifest.json 缺失 → manifest.missing', () => {
        const root = makeRoot();
        mkdirSync(join(root, 'ghost'));
        expect(codesFor(open(root), 'ghost')).toContain('manifest.missing');
    });

    it('manifest.json 非法 JSON → manifest.missing', () => {
        const root = makeRoot();
        writeSkillPackage(root, { id: 'demo' });
        writeFileSync(join(root, 'demo', 'manifest.json'), '{ not json');
        expect(codesFor(open(root), 'demo')).toContain('manifest.missing');
    });

    it('缺必填字段 → required.missing', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        delete manifest.description;
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('required.missing');
    });

    it('id 与目录名不一致 → id.mismatch', () => {
        const root = makeRoot();
        writeSkillPackage(root, { id: 'demo', manifest: defaultManifest('other') });
        expect(codesFor(open(root), 'demo')).toContain('id.mismatch');
    });

    it('version 非 semver → version.invalid', () => {
        const root = makeRoot();
        writeSkillPackage(root, { id: 'demo', manifest: { ...defaultManifest('demo'), version: 'v1' } });
        expect(codesFor(open(root), 'demo')).toContain('version.invalid');
    });

    it('未知主域/子类 → intent.unknown', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.intents = { domains: ['bogus'], categories: ['habit'], keywords: [] };
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('intent.unknown');
    });

    it('非法 permissionCeiling → permission.ceiling-invalid', () => {
        const root = makeRoot();
        writeSkillPackage(root, {
            id: 'demo',
            manifest: { ...defaultManifest('demo'), permissionCeiling: 'root' },
        });
        expect(codesFor(open(root), 'demo')).toContain('permission.ceiling-invalid');
    });

    it('manifest.tools 引用不可解析 → tool.unresolvable', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.tools = ['demo.append', 'ghost.tool'];
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('tool.unresolvable');
    });

    it('工具 minPermission 越过 permissionCeiling → tool.permission-exceeds-ceiling', () => {
        const root = makeRoot();
        const tool = { ...defaultTool(), minPermission: 'approved' };
        writeSkillPackage(root, { id: 'demo', tools: { 'demo.append': tool } });
        expect(codesFor(open(root), 'demo')).toContain('tool.permission-exceeds-ceiling');
    });

    it('工具 handler 绑定缺失 → tool.invalid', () => {
        const root = makeRoot();
        const tool = { ...defaultTool() };
        delete tool.handler;
        writeSkillPackage(root, { id: 'demo', tools: { 'demo.append': tool } });
        expect(codesFor(open(root), 'demo')).toContain('tool.invalid');
    });

    it('模板引用不可解析 → template.unresolvable', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.templates = ['demo-prompt', 'ghost-prompt'];
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('template.unresolvable');
    });

    it('校验器引用不可解析 → validator.unresolvable', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.validators = ['entry', 'ghost'];
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('validator.unresolvable');
    });

    it('记忆集合缺 schema → memory.unresolvable', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.memory = { collections: [{ name: 'ghost', sensitivity: 'normal' }] };
        writeSkillPackage(root, { id: 'demo', manifest, memory: { entries: { type: 'object' } } });
        expect(codesFor(open(root), 'demo')).toContain('memory.unresolvable');
    });

    it('非法敏感度 → memory.sensitivity-invalid', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.memory = { collections: [{ name: 'entries', sensitivity: 'private' }] };
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('memory.sensitivity-invalid');
    });

    it('事件名违反 skill.<id>.<name> → event.naming-invalid', () => {
        const root = makeRoot();
        const manifest = defaultManifest('demo');
        manifest.events = { emits: ['demo.created'], subscribes: [] };
        writeSkillPackage(root, { id: 'demo', manifest });
        expect(codesFor(open(root), 'demo')).toContain('event.naming-invalid');
    });

    it('跨包工具名冲突 → 后到者 tool.duplicate 拒绝加载', () => {
        const root = makeRoot();
        writeSkillPackage(root, { id: 'alpha' });
        writeSkillPackage(root, { id: 'beta' });
        const registry = open(root);
        expect(registry.has('alpha')).toBe(true);
        expect(registry.has('beta')).toBe(false);
        expect(codesFor(registry, 'beta')).toContain('tool.duplicate');
    });
});
