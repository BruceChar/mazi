import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MemoryBlackboardStore,
    ProjectBlackboardService,
} from '../src/blackboard/index.js';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/runtime.js';

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
});

function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'mazi-blackboard-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
            name: 'demo-project',
            description: '用于验证项目黑板的示例项目',
            dependencies: { react: '^19' },
            devDependencies: { typescript: '^7' },
        }),
    );
    writeFileSync(join(root, 'README.md'), '# Demo\n\n项目说明');
    return root;
}

function scriptedProvider(systemPrompts: string[]): LLMProvider {
    return {
        id: 'default',
        name: 'scripted',
        defaultModel: 'scripted-model',
        models: [],
        async ask(request: LLMRequest) {
            systemPrompts.push(request.system ?? '');
            return {
                model: 'scripted-model',
                content: [{ type: 'text', text: '已完成项目检查。' }],
                finishReason: 'stop',
            };
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            systemPrompts.push(request.system ?? '');
            yield { type: 'text_delta', text: '已完成项目检查。' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function config(dbPath = ':memory:'): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath,
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-blackboard-events-')),
        goal: { allowedTools: [] },
        contextWindow: 64_000,
        consoleEnabled: false,
    };
}

describe('ProjectBlackboardService', () => {
    it('bootstraps once, injects a compact summary and updates from completed runs', async () => {
        const root = workspace();
        const store = new MemoryBlackboardStore();
        let now = 100;
        const service = new ProjectBlackboardService(store, () => now++);
        const board = await service.ensure('p1', root);
        expect(board).toMatchObject({
            projectId: 'p1',
            name: 'demo-project',
            purpose: '用于验证项目黑板的示例项目',
            version: 1,
        });
        expect(service.promptFragment(board)).toContain('项目黑板');
        expect(service.promptFragment(board)).toContain('下一步');

        const updated = await service.updateFromRun('p1', root, {
            rootGoalId: 'r1',
            statement: '完成黑板集成',
            ok: true,
            reason: 'completed',
            finalMessage: '黑板集成完成',
            taskTitles: ['实现', '测试'],
            changedPaths: ['src/board.ts'],
            now: 1000,
        });
        expect(updated).toMatchObject({ version: 2, lastVerifiedAt: 1000 });
        expect(updated.completedMilestones).toContain('黑板集成完成');
        expect(updated.recentChanges.join('\n')).toContain('src/board.ts');
        expect(updated.evidenceRefs.some((entry) => entry.ref === 'r1')).toBe(true);
    });

    it('detects source changes without rebuilding the board', async () => {
        const root = workspace();
        const service = new ProjectBlackboardService(new MemoryBlackboardStore());
        await service.ensure('p1', root);
        writeFileSync(join(root, 'package.json'), '{"name":"changed"}');
        expect(await service.isStale('p1', root)).toBe(true);
        const stale = await service.ensure('p1', root);
        expect(stale.knownIssues.join('\n')).toContain('源指纹变化');
        const reconciled = await service.reconcile('p1', root);
        expect(reconciled.version).toBe(3);
        expect(await service.isStale('p1', root)).toBe(false);
    });

    it('injects the project board into a new session and persists run progress', async () => {
        const root = workspace();
        const prompts: string[] = [];
        const provider = scriptedProvider(prompts);
        const runtime = new HarnessRuntime(config(), {
            workspaceRoot: root,
            llmProviders: { default: provider },
        });
        closers.push(() => runtime.close());

        await runtime.runGoalSession('检查项目状态', {
            projectId: 'p1',
            llmProviders: { default: provider },
            maxSteps: 2,
        });
        await runtime.runGoalSession('继续处理下一步', {
            projectId: 'p1',
            llmProviders: { default: provider },
            maxSteps: 2,
        });
        expect(prompts.some((prompt) => prompt.includes('# 项目黑板：demo-project'))).toBe(true);
        const board = await runtime.projectBlackboard('p1');
        expect(board?.completedMilestones.length).toBeGreaterThan(0);
        expect(board?.version).toBeGreaterThan(1);
    });
});
