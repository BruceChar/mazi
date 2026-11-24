import 'reflect-metadata';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalService } from '../src/eval/eval.service.js';
import { EvalController } from '../src/eval/eval.controller.js';
import type { EvalRunRecord } from '@mazi/runtime';
import { SqliteEvalRunStore } from '@mazi/runtime';
import { describe, expect, it } from 'vitest';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';

const SNAPSHOT = {
    goals: [
        {
            tasks: [
                {
                    steps: [
                        {
                            stepId: 'step-1',
                            goalId: 'eval-goal',
                            taskId: 'task-1',
                            kind: 'invocation',
                            status: 'succeeded',
                            startedAt: 1,
                            toolName: 'fs.read',
                        },
                    ],
                },
            ],
        },
    ],
};

function runResult(rootGoalId: string, aborted: boolean) {
    return {
        rootGoalId,
        ok: !aborted,
        tasks: [
            {
                ok: !aborted,
                reason: aborted ? 'aborted' : 'final-answer',
                finalMessage: aborted ? 'stopped' : 'ok',
                steps: [],
                task: {
                    taskId: 'task-1',
                    goalId: rootGoalId,
                    title: 'eval',
                    acceptance: { conditions: ['answer'] },
                    status: aborted ? 'stopped' : 'succeeded',
                    acceptanceResult: {
                        checkedAt: 1,
                        passed: !aborted,
                        evaluated: 1,
                        total: 1,
                        conditions: [{ conditionId: 'answer', status: aborted ? 'failed' : 'passed' }],
                    },
                },
            },
        ],
    };
}

/** 可控 harness：executeGoalTree 卡在 gate 上，stopGoalTree 触发中止并放行。 */
function createHarness(gated = false) {
    let rootGoalId = '';
    let aborted = false;
    let release: (() => void) | undefined;
    const gate = gated
        ? new Promise<void>((resolve) => {
              release = resolve;
          })
        : Promise.resolve();
    const harness = {
        async createGoalSession() {
            rootGoalId = 'eval-goal';
            return { rootGoalId, goalId: rootGoalId };
        },
        async executeGoalTree() {
            await gate;
            return runResult(rootGoalId, aborted);
        },
        async resumeGoalTree() {
            return runResult(rootGoalId, false);
        },
        stopGoalTree() {
            aborted = true;
            release?.();
            return true;
        },
        isGoalRunning() {
            return !aborted;
        },
        async goalSnapshot() {
            return SNAPSHOT;
        },
        eventBus: {
            replay: () => [],
        },
    };
    return {
        harness,
        release: () => release?.(),
    };
}

function setup(dbPath = ':memory:', runtimeHarness = createHarness().harness) {
    const runtime = {
        harness: () => runtimeHarness,
        setWorkspaceRoot: () => undefined,
        homePaths: { dbPath },
    } as unknown as ApiRuntimeService;
    const service = new EvalService(runtime);
    return {
        controller: new EvalController(service, {
            allRuns: () => [],
        } as never),
        service,
    };
}

async function waitForRun(
    controller: EvalController,
    runId: string,
    predicate: (run: EvalRunRecord) => boolean,
    timeoutMs = 2000,
) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const run = await controller.runDetail(runId);
        if (predicate(run)) return run;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`run ${runId} did not reach expected state`);
}

async function waitForStatus(
    controller: EvalController,
    runId: string,
    status: string,
    taskStatus?: string,
    timeoutMs = 2000,
) {
    return waitForRun(
        controller,
        runId,
        (run) =>
            run.status === status &&
            (taskStatus === undefined || run.progress?.[0]?.status === taskStatus),
        timeoutMs,
    );
}

describe('eval controller', () => {
    it('未指定工作区时默认落到 $MAZI_HOME/testsuites，且不注册为用户项目', async () => {
        const home = mkdtempSync(join(tmpdir(), 'mazi-eval-home-'));
        const calls: Array<{ root?: string; options?: { register?: boolean } }> = [];
        const runtime = {
            harness: () => createHarness().harness,
            setWorkspaceRoot: (root?: string, options?: { register?: boolean }) => {
                calls.push({ root, options });
            },
            homePaths: { dbPath: ':memory:', home },
        } as unknown as ApiRuntimeService;
        const service = new EvalService(runtime);
        const controller = new EvalController(service, { allRuns: () => [] } as never);

        const started = await controller.run({ taskIds: ['read-report'] });
        expect(started.workspace).toBe(join(home, 'testsuites'));
        expect(existsSync(join(home, 'testsuites'))).toBe(true);
        expect(calls[0]?.options).toEqual({ register: false });
        await waitForStatus(controller, started.runId, 'completed');
        service.onApplicationShutdown();
    });

    it('lists the 30-task baseline dataset', () => {
        const { controller, service } = setup();
        const result = controller.tasks();
        expect(result.dataset).toBe('p0-baseline');
        expect(result.tasks).toHaveLength(30);
        service.onApplicationShutdown();
    });

    it('starts a run in the background and exposes per-task progress', async () => {
        const controlled = createHarness(true);
        const { controller, service } = setup(':memory:', controlled.harness);
        const started = await controller.run({ taskIds: ['read-report'] });
        expect(started.status).toBe('running');
        expect(started.progress).toMatchObject([{ taskId: 'read-report', status: 'pending' }]);

        const running = await waitForRun(
            controller,
            started.runId,
            (run) => run.progress?.[0]?.rootGoalId === 'eval-goal',
        );
        expect(running.progress?.[0]).toMatchObject({
            status: 'running',
            rootGoalId: 'eval-goal',
        });

        controlled.release();
        const completed = await waitForStatus(controller, started.runId, 'completed', 'completed');
        expect(completed.progress?.[0]?.status).toBe('completed');
        expect(completed.report?.overall).toMatchObject({ tasks: 1, successRate: 1 });
        service.onApplicationShutdown();
    });

    it('runs selected tasks and returns a persisted report', async () => {
        const { controller, service } = setup();
        const run = await service.run({
            taskIds: ['read-report'],
            modelId: 'faux-model',
            promptPackId: 'general',
        });
        expect(run.status).toBe('completed');
        expect(run.report?.overall).toMatchObject({
            tasks: 1,
            successes: 1,
            successRate: 1,
        });
        expect((await controller.report(run.runId)).results).toHaveLength(1);
        expect((await controller.runs()).runs[0]?.runId).toBe(run.runId);
        service.onApplicationShutdown();
    });

    it('rejects unknown tasks before starting a run', async () => {
        const { controller, service } = setup();
        await expect(controller.run({ taskIds: ['missing'] })).rejects.toThrow(/未知评测任务/);
        service.onApplicationShutdown();
    });

    it('stops a running task and resumes it from the persisted checkpoint', async () => {
        const controlled = createHarness(true);
        const { controller, service } = setup(':memory:', controlled.harness);
        const started = await controller.run({ taskIds: ['read-report'] });
        await waitForStatus(controller, started.runId, 'running', 'running');

        const stopped = await controller.stop(started.runId, {});
        expect(stopped.stopping).toEqual(['read-report']);
        const aborted = await waitForStatus(controller, started.runId, 'aborted');
        expect(aborted.progress?.[0]).toMatchObject({
            status: 'stopped',
            rootGoalId: 'eval-goal',
        });

        const resumed = await controller.resume(started.runId, {});
        expect(resumed.status).toBe('running');
        const completed = await waitForStatus(controller, started.runId, 'completed');
        expect(completed.progress?.[0]?.status).toBe('completed');
        service.onApplicationShutdown();
    });

    it('converges a run orphaned by a restart to aborted and resumes it', async () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), 'mazi-eval-crash-')), 'mazi.db');
        const seed = new SqliteEvalRunStore(dbPath);
        await seed.save({
            runId: 'crash-run',
            status: 'running',
            taskIds: ['read-report'],
            startedAt: 1,
            progress: [
                {
                    taskId: 'read-report',
                    title: '读取并复述 AGENTS.md 的约束',
                    status: 'running',
                    rootGoalId: 'orphan-goal',
                    startedAt: 1,
                },
            ],
        });
        seed.close();

        const { controller, service } = setup(dbPath);
        await service.onModuleInit();
        const detail = await controller.runDetail('crash-run');
        expect(detail.status).toBe('aborted');
        expect(detail.progress?.[0]).toMatchObject({
            status: 'stopped',
            rootGoalId: 'orphan-goal',
        });

        await controller.resume('crash-run', {});
        const completed = await waitForStatus(controller, 'crash-run', 'completed');
        expect(completed.progress?.[0]?.status).toBe('completed');
        service.onApplicationShutdown();
    });

    it('loads completed runs after the service is recreated', async () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), 'mazi-eval-store-')), 'mazi.db');
        const first = setup(dbPath);
        const run = await first.service.run({ taskIds: ['read-report'] });
        first.service.onApplicationShutdown();

        const second = setup(dbPath);
        const detail = await second.controller.runDetail(run.runId);
        expect(detail.report?.results).toHaveLength(1);
        expect(detail.progress).toMatchObject([{ taskId: 'read-report', status: 'completed' }]);
        expect((await second.controller.runs()).runs[0]?.runId).toBe(run.runId);
        second.service.onApplicationShutdown();
    });
});
