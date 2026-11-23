import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ASSEMBLY_MODULES,
    type AssemblyModule,
    assertAssemblyComplete,
} from '../src/harness/assembly/modules.js';
import { HarnessRuntime } from '../src/harness/index.js';
import { createRuntimeContext } from '../src/harness/runtime-context.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('装配模块数组', () => {
    it('模块按段划分，owned 键不重复', () => {
        const names = ASSEMBLY_MODULES.map((module) => module.name);
        expect(names).toEqual([
            'core-values',
            'stores',
            'intelligence',
            'delegation',
            'analysis',
            'executors',
            'kernel',
        ]);
        expect(ASSEMBLY_MODULES.filter((m) => m.segment === 'features').map((m) => m.name)).toEqual([
            'delegation',
            'analysis',
        ]);
        const owned = ASSEMBLY_MODULES.flatMap((module) => module.owned);
        expect(new Set(owned).size).toBe(owned.length);
    });

    it('装配完成后 owned 全部有值；core 子集同样自洽', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-assembly-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(
            {
                providers: [],
                tools: [],
                eventDir: dir,
                goal: { permissionCeiling: 'read-only' },
                contextWindow: 64000,
                wiki: { enabled: false },
            },
            { workspaceRoot: dir },
        );
        try {
            expect(() => assertAssemblyComplete(runtime.context)).not.toThrow();
            const core = ASSEMBLY_MODULES.filter((module) => module.segment === 'core');
            expect(() => assertAssemblyComplete(runtime.context, core)).not.toThrow();
        } finally {
            await runtime.close();
        }
    });

    it('disabledModules 关闭 features 段：平面为 undefined，查询接口降级', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-features-off-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(
            {
                providers: [],
                tools: [],
                eventDir: dir,
                goal: { permissionCeiling: 'read-only' },
                contextWindow: 64000,
                wiki: { enabled: false },
            },
            { workspaceRoot: dir, disabledModules: ['analysis', 'delegation'] },
        );
        try {
            expect(runtime.context.analysis).toBeUndefined();
            expect(runtime.context.delegation).toBeUndefined();
            expect(runtime.agentRoles()).toEqual([]);
            expect(await runtime.delegationEdges('root')).toEqual([]);
            expect(runtime.removeAgentRole('x')).toBe(false);
            expect(() => runtime.tocAnalyst).toThrow(/analysis 模块未启用/);
            expect(() => runtime.registerAgentRole({ roleId: 'x' } as never)).toThrow(
                /delegation 模块未启用/,
            );
            expect(runtime.context.assembly.resources.openCount()).toBe(0);
        } finally {
            await runtime.close();
        }
    });

    it('删掉模块导致的空壳在启动期暴露', () => {
        const empty = createRuntimeContext();
        const fake: AssemblyModule = {
            name: 'ghost',
            segment: 'features',
            owned: ['memory.wiki', 'session.factory'],
            create: () => undefined,
        };
        expect(() => assertAssemblyComplete(empty, [fake])).toThrow(/装配缺失/);
    });
});
