import 'reflect-metadata';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    HarnessRuntime,
    projectIdForWorkspace,
    type RuntimeConfig,
} from '@mazi/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';
import { ProjectsController } from '../src/projects/projects.controller.js';

const closeHandlers: Array<() => void> = [];
afterEach(() => {
    for (const close of closeHandlers.splice(0).reverse()) close();
});

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'mazi-project-api-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'project-api', description: '项目黑板 API 测试' }),
    );
    return root;
}

function config(): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-project-api-events-')),
        goal: { allowedTools: [] },
        contextWindow: 32_000,
    };
}

describe('projects blackboard controller', () => {
    it('returns and reconciles a project blackboard', async () => {
        const workspace = fixture();
        const runtime = new HarnessRuntime(config(), { workspaceRoot: workspace });
        closeHandlers.push(() => runtime.close());
        const fake = {
            harness: () => runtime,
            setWorkspaceRoot: () => undefined,
        } as unknown as ApiRuntimeService;
        const controller = new ProjectsController(fake);
        const projectId = projectIdForWorkspace(workspace);

        const initial = await controller.blackboard(projectId);
        expect(initial.board).toMatchObject({
            projectId,
            name: 'project-api',
            purpose: '项目黑板 API 测试',
            version: 1,
        });

        writeFileSync(join(workspace, 'README.md'), '# changed');
        const reconciled = await controller.reconcile(projectId);
        expect(reconciled.board.version).toBe(2);
    });
});
