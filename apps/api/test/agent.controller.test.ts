import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessRuntime, type RuntimeConfig } from '@mazi/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentController } from '../src/agent/agent.controller.js';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';

const closers: Array<() => void> = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

function setup(): AgentController {
    const config: RuntimeConfig = {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-agent-api-')),
        goal: { allowedTools: [] },
        contextWindow: 32_000,
    };
    const runtime = new HarnessRuntime(config);
    closers.push(() => runtime.close());
    return new AgentController({
        harness: () => runtime,
    } as unknown as ApiRuntimeService);
}

describe('agent controller', () => {
    it('lists, registers and removes PromptPacks', async () => {
        const controller = setup();
        const initial = await controller.promptPacks();
        expect(initial.packs.some((pack) => pack.id === 'coding')).toBe(true);

        const created = await controller.registerPromptPack({
            id: 'project-a',
            name: 'Project A',
            description: '项目 A 规则',
            module: '遵循项目 A 的接口约定。',
            version: 2,
            priority: 20,
            matcher: { projectIds: ['p-a'], taskKinds: ['coding'] },
        });
        expect(created.pack).toMatchObject({ id: 'project-a', version: 2 });
        const preview = await controller.preview({
            projectId: 'p-a',
            input: '实现接口',
            tools: ['fs.read', 'sd'],
        });
        expect(preview.decision.promptPackIds).toContain('project-a');
        expect(controller.removePromptPack('project-a')).toEqual({ ok: true, removed: true });
    });

    it('previews SuperAgent decisions and verifier status', async () => {
        const controller = setup();
        const preview = await controller.preview({
            input: '继续上次那个数据库迁移项目',
            userId: 'u1',
            projectId: 'p1',
        });
        expect(preview.decision).toMatchObject({
            taskKind: 'memory',
            plannerId: 'task-graph',
            verifierId: 'independent-default',
            blackboardRequired: true,
        });
        expect(controller.verifier()).toEqual({
            id: 'independent-default',
            semanticJudge: false,
        });
    });

    it('exposes role registration and delegation edge queries', async () => {
        const controller = setup();
        expect(controller.roles().roles.map((role) => role.roleId)).toContain('reviewer');
        const registered = controller.registerRole({
            roleId: 'tester',
            label: '测试 Agent',
            tools: ['fs.read', 'shell.run'],
            defaultCeiling: 'workspace-write',
        });
        expect(registered.role).toMatchObject({
            roleId: 'tester',
            memoryPolicy: 'inherit',
        });
        expect(await controller.delegations('missing')).toEqual({ edges: [] });
    });
});
