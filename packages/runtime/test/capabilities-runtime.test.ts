/**
 * 技能运行时：挂载状态持久化 / 工具面 / 天花板 / 记忆隔离 / 审计事件
 * （docs/能力包规范.md §7.2 / §9 / §13 CP-2/3/4/5/8/9/10）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillRootScope } from '../src/capabilities/index.js';
import {
    asSkillRoot,
    CapabilityRegistry,
    FileSkillMountStore,
    MemorySkillMountStore,
    SkillRuntime,
    type SkillRunContext,
} from '../src/capabilities/index.js';
import type { ToolCallResult } from '../src/config.js';
import { capabilityForTool, RuntimeToolGateway } from '../src/tool-gateway/permission.js';
import { defaultManifest, defaultTool, writeSkillPackage } from './helpers/skill-package.js';
import { RecordingBus } from './helpers/recording-bus.js';

const dirs: string[] = [];

function makeRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-skill-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface PackageOptions {
    manifest?: Record<string, unknown>;
    tools?: Record<string, unknown>;
    memory?: Record<string, unknown> | null;
    validators?: Record<string, string>;
    handlers?: Record<string, string>;
}

function writePackage(root: string, id: string, options: PackageOptions = {}): void {
    const manifest = options.manifest ?? defaultManifest(id);
    writeSkillPackage(root, {
        id,
        manifest: { ...manifest, id, tools: [id + '.append'] },
        tools: options.tools ?? { [id + '.append']: { ...defaultTool(), name: id + '.append' } },
        ...(options.memory !== undefined ? { memory: options.memory } : {}),
        ...(options.validators !== undefined ? { validators: options.validators } : {}),
        ...(options.handlers !== undefined ? { handlers: options.handlers } : {}),
    });
}

function registryWith(root: string, ids: readonly string[], scope: SkillRootScope = 'user'): CapabilityRegistry {
    return CapabilityRegistry.open({ roots: [asSkillRoot(root, scope)] });
}

/** 为未显式写入的 id 补一个默认包（显式写入的自定义包不被覆盖）。 */
function ensurePackages(root: string, ids: readonly string[]): void {
    for (const id of ids) {
        if (!existsSync(join(root, id))) writePackage(root, id);
    }
}

async function runtimeWith(
    root: string,
    ids: readonly string[],
    state: MemorySkillMountStore | FileSkillMountStore = new MemorySkillMountStore(),
): Promise<SkillRuntime> {
    ensurePackages(root, ids);
    const registry = registryWith(root, ids);
    const runtime = new SkillRuntime({ registry, state });
    await runtime.init();
    return runtime;
}

async function invoke(
    runtime: SkillRuntime,
    toolName: string,
    args: Record<string, unknown>,
    context: SkillRunContext = { rootGoalId: 'root' },
): Promise<ToolCallResult> {
    const tool = runtime.toolConfigs(context).find((candidate) => candidate.name === toolName);
    if (tool?.impl === undefined) throw new Error('工具未物化：' + toolName);
    return tool.impl(args);
}

describe('CP-10 挂载状态：发现 / 挂载 / 卸载 / 持久化', () => {
    it('挂载写入 skills.json，新实例 init() 后仍保持挂载；卸载写回空表', async () => {
        const root = makeRoot();
        const stateFile = join(makeRoot(), 'skills.json');
        const state = new FileSkillMountStore(stateFile);
        const first = await runtimeWith(root, ['alpha'], state);
        expect(first.list().map((view) => view.mounted)).toEqual([false]);
        await first.mount('alpha');
        expect(first.isMounted('alpha')).toBe(true);
        expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ mounted: ['alpha'] });

        const second = await runtimeWith(root, ['alpha'], state);
        expect(second.mounted()).toEqual(['alpha']);
        expect(second.toolConfigs({ rootGoalId: 'root' })).toHaveLength(1);

        await second.unmount('alpha');
        expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ mounted: [] });
    });

    it('未发现/未通过校验的包拒绝挂载；重复挂载幂等', async () => {
        const root = makeRoot();
        writePackage(root, 'alpha');
        const runtime = await runtimeWith(root, ['alpha']);
        await expect(runtime.mount('ghost')).rejects.toThrow();
        await runtime.mount('alpha');
        await runtime.mount('alpha');
        expect(runtime.mounted()).toEqual(['alpha']);
    });

    it('卸载后工具面立即消失、重复卸载返回 false', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha']);
        await runtime.mount('alpha');
        expect(runtime.toolConfigs({ rootGoalId: 'root' })).toHaveLength(1);
        expect(await runtime.unmount('alpha')).toBe(true);
        expect(runtime.toolConfigs({ rootGoalId: 'root' })).toEqual([]);
        expect(await runtime.unmount('alpha')).toBe(false);
    });

    it('反复挂载/卸载 3 次无残留（CP-3）', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha']);
        for (let round = 0; round < 3; round += 1) {
            await runtime.mount('alpha');
            expect(runtime.toolConfigs({ rootGoalId: 'root' })).toHaveLength(1);
            await runtime.unmount('alpha');
        }
        expect(runtime.mounted()).toEqual([]);
        expect(runtime.toolConfigs({ rootGoalId: 'root' })).toEqual([]);
    });
});

describe('CP-2 工具面：物化 / 校验 / 模板', () => {
    it('挂载后工具可调用，handler 写回本包命名空间', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha']);
        await runtime.mount('alpha');
        const result = await invoke(runtime, 'alpha.append', { value: '第一条' });
        expect(result.ok).toBe(true);
        expect(String(result.content)).toContain('第一条');
        expect(await runtime.memoryOf('alpha')?.list('entries')).toHaveLength(1);
    });

    it('前置校验失败 → 工具失败 + capability.validation.failed（携 skillId）', async () => {
        const root = makeRoot();
        const bus = new RecordingBus();
        const runtime = await runtimeWith(root, ['alpha']);
        await runtime.mount('alpha');
        const result = await invoke(runtime, 'alpha.append', { value: '   ' }, {
            rootGoalId: 'root',
            goalId: 'goal',
            emit: (event) => bus.emit(event),
        });
        expect(result.ok).toBe(false);
        const failure = bus.events.find((event) => event.type === 'capability.validation.failed');
        expect(failure?.attributes['harness.skill_id']).toBe('alpha');
        expect(failure?.attributes['harness.level']).toBe('warn');
        expect(await runtime.memoryOf('alpha')?.list('entries')).toEqual([]);
    });

    it('模板：{{var}} 替换、未知占位保留、未声明模板抛错', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha']);
        expect(runtime.renderTemplate('alpha', 'demo-prompt', { value: '42' })).toBe(
            '# 夹具提示 42',
        );
        expect(runtime.renderTemplate('alpha', 'demo-prompt', {})).toBe('# 夹具提示 {{value}}');
        expect(() => runtime.renderTemplate('alpha', 'ghost-prompt')).toThrow();
    });
});

describe('CP-5/CP-9 记忆隔离与敏感度', () => {
    it('命名空间按 skillId 隔离：A 写的 B 读不到', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha', 'beta']);
        await runtime.mount('alpha');
        await runtime.mount('beta');
        await invoke(runtime, 'alpha.append', { value: 'A 的记录' });
        await invoke(runtime, 'beta.append', { value: 'B 的记录' });
        expect(await runtime.memoryOf('alpha')?.list('entries')).toEqual([{ value: 'A 的记录' }]);
        expect(await runtime.memoryOf('beta')?.list('entries')).toEqual([{ value: 'B 的记录' }]);
    });

    it('未声明的集合拒绝访问；secret 只写不读回', async () => {
        const root = makeRoot();
        const manifest = defaultManifest('vault');
        writePackage(root, 'vault', {
            manifest: {
                ...manifest,
                memory: { collections: [{ name: 'secret-notes', sensitivity: 'secret' }] },
            },
            memory: { 'secret-notes': { type: 'object' } },
            handlers: {
                './handlers/capture.ts': `export async function capture(args, ctx) {
    await ctx.memory.append('secret-notes', { value: args.value });
    return { ok: true };
}
`,
            },
        });
        const runtime = await runtimeWith(root, ['vault']);
        await runtime.mount('vault');
        expect((await invoke(runtime, 'vault.append', { value: '密钥' })).ok).toBe(true);
        expect(await runtime.memoryOf('vault')?.list('secret-notes')).toEqual([]);
        await expect(runtime.memoryOf('vault')?.list('undeclared')).rejects.toThrow();
    });

    it('contextMemory 只注入 normal 集合（sensitive/secret 不进上下文）', async () => {
        const root = makeRoot();
        const manifest = defaultManifest('alpha');
        writePackage(root, 'alpha', {
            manifest: {
                ...manifest,
                memory: {
                    collections: [
                        { name: 'entries', sensitivity: 'sensitive' },
                        { name: 'streaks', sensitivity: 'normal' },
                    ],
                },
            },
            memory: { entries: { type: 'object' }, streaks: { type: 'object' } },
        });
        const runtime = await runtimeWith(root, ['alpha']);
        await runtime.mount('alpha');
        await invoke(runtime, 'alpha.append', { value: '敏感内容' });
        expect(await runtime.contextMemory('alpha')).toEqual({ streaks: [] });
        expect(await runtime.memoryOf('alpha')?.list('entries')).toHaveLength(1);
    });
});

describe('CP-4 权限天花板', () => {
    it('生效档位 = min(goal, 各已挂载包 permissionCeiling)', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha']);
        await runtime.mount('alpha');
        expect(runtime.effectivePermissionLevel('autonomous')).toBe('draft');
        expect(runtime.effectivePermissionLevel('read-only')).toBe('read-only');
        await runtime.unmount('alpha');
        expect(runtime.effectivePermissionLevel('autonomous')).toBe('autonomous');
    });

    it('db 写工具：autonomous 直通、收敛到 draft 后触发审批被拦截、text 隐藏', async () => {
        const root = makeRoot();
        const runtime = await runtimeWith(root, ['alpha']);
        await runtime.mount('alpha');
        const tools = runtime.toolConfigs({ rootGoalId: 'root' });
        const reject = { decide: async () => ({ decision: 'rejected' as const, reason: '测试拒绝' }) };
        const gatewayAt = (level: 'autonomous' | 'draft' | 'text'): RuntimeToolGateway =>
            new RuntimeToolGateway({
                rootGoalId: 'root',
                goalId: 'goal',
                taskId: 'task',
                level,
                tools,
                execute: (tool, args) =>
                    tool.impl ? tool.impl(args) : Promise.resolve({ ok: false, error: 'no impl' }),
                approval: { decide: async () => reject.decide() },
            });
        expect((await gatewayAt('autonomous').invoke('alpha.append', { value: 'x' })).ok).toBe(true);
        expect(
            (
                await gatewayAt('draft').invoke('alpha.append', { value: 'x' })
            ).ok,
        ).toBe(false);
        expect(gatewayAt('text').visibleToolNames()).toEqual([]);
    });

    it('声明式副作用 → 分派能力（§6.1）', () => {
        const base = { name: 'demo', description: '', parameters: {}, minPermission: 'draft' as const };
        expect(capabilityForTool({ ...base, sideEffects: ['pay'] })).toBe('pay');
        expect(capabilityForTool({ ...base, sideEffects: ['external-api'] })).toBe('net.send');
        expect(capabilityForTool({ ...base, sideEffects: ['db'] })).toBe('db.write');
        expect(capabilityForTool({ ...base, sideEffects: ['process'] })).toBe('fs.exec');
        expect(capabilityForTool({ ...base, sideEffects: ['fs'] })).toBe('fs.write.workspace');
        expect(capabilityForTool({ ...base, sideEffects: ['net'] })).toBe('net.fetch');
        expect(capabilityForTool({ ...base, sideEffects: ['net'], irreversible: true })).toBe(
            'net.send',
        );
        expect(capabilityForTool({ ...base, sideEffects: [] })).toBe('fs.read.workspace');
    });
});
