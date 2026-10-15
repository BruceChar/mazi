/**
 * ExperimentsService 编排（docs/AB测试设计.md §7/§8.2）。
 * 关键不变量：实验跑在专用运行时 + 专用串行锁上 —— 主会话锁忙不影响实验，
 * 实验锁忙也不影响主会话；工作区冻结进 spec，且不切换主会话的当前工作区。
 */

import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentSpec, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { ProviderError, resolveFeatures } from '@mazi/core';
import type { ExperimentStore, FeatureRuntime, RuntimeConfig } from '@mazi/runtime';
import {
    FeatureRuntime as FeatureRuntimeClass,
    HarnessRuntime,
    MemoryExperimentStore,
    MemoryFeatureStore,
    type DefaultEventBus,
} from '@mazi/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/api-error.js';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';
import { ExperimentsService } from '../src/experiments/experiments.service.js';

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

function branchingProvider(requests: LLMRequest[]): LLMProvider {
    return {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            requests.push(request);
            const system = typeof request.system === 'string' ? request.system : '';
            yield { type: 'start', model: request.model ?? 'default' };
            yield { type: 'text_delta', text: system.includes('简洁作答') ? 'B 答案' : 'A 答案' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

/** 阻塞到被 abort 的 provider（两臂会一直"运行中"，用于验证随时终止）。 */
function blockingProvider(): LLMProvider {
    const waitForAbort = (signal?: AbortSignal): Promise<void> =>
        new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
                resolve();
                return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
        });
    return {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            yield { type: 'start', model: request.model ?? 'default' };
            await waitForAbort(request.signal);
            throw new ProviderError('aborted', 'caller aborted');
        },
    };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('等待条件超时');
}

/** 只暴露 ExperimentsService 需要的运行时能力；两把锁独立，便于验证互不阻塞。 */
class StubRuntime {
    selectedWorkspaceRoot: string | undefined;
    freeChatWorkspace = '/free-chat';
    readonly workspaceCalls: Array<string | undefined> = [];
    readonly experimentHarnessCalls: Array<string | undefined> = [];
    chatLockBusy = false;
    experimentLockBusy = false;
    constructor(
        private readonly harnessInstance: HarnessRuntime,
        private readonly storeInstance: ExperimentStore,
        private readonly featureRuntime: FeatureRuntime,
    ) {}
    setWorkspaceRoot(root?: string): void {
        this.workspaceCalls.push(root);
        this.selectedWorkspaceRoot = root;
    }
    harness(): HarnessRuntime {
        return this.harnessInstance;
    }
    /** 测试观察用：拿到真实 HarnessRuntime（判断某 rootGoal 是否在跑）。 */
    rawHarness(): HarnessRuntime {
        return this.harnessInstance;
    }
    experimentHarness(workspace?: string): HarnessRuntime {
        this.experimentHarnessCalls.push(workspace);
        return this.harnessInstance;
    }
    experiments(): ExperimentStore {
        return this.storeInstance;
    }
    features(): Promise<FeatureRuntime> {
        return Promise.resolve(this.featureRuntime);
    }
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.chatLockBusy) throw new ApiError(409, '已有会话在运行，请稍候');
        return operation();
    }
    runExperimentExclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.experimentLockBusy) throw new ApiError(409, '已有实验在运行，请稍候');
        return operation();
    }
}

interface Harness {
    service: ExperimentsService;
    store: ExperimentStore;
    runtime: StubRuntime;
    requests: LLMRequest[];
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harnessWith(
    initialWorkspace?: string,
    options: { blocking?: boolean } = {},
): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-exp-svc-'));
    dirs.push(dir);
    const requests: LLMRequest[] = [];
    const harnessRuntime = new HarnessRuntime(configIn(dir), {
        llmProviders: {
            default: options.blocking ? blockingProvider() : branchingProvider(requests),
        },
    });
    const store = new MemoryExperimentStore();
    const features = new FeatureRuntimeClass({
        store: new MemoryFeatureStore([
            {
                id: 'concise',
                name: '简洁作答',
                description: '先给结论',
                enabled: false,
                promptFragment: '简洁作答',
            },
        ]),
    });
    await features.init();
    const runtime = new StubRuntime(harnessRuntime, store, features);
    runtime.selectedWorkspaceRoot = initialWorkspace;
    return {
        service: new ExperimentsService(runtime as unknown as ApiRuntimeService),
        store,
        runtime,
        requests,
    };
}

function specOf(workspace?: string): ExperimentSpec {
    return {
        title: 'Feature 增益',
        input: '介绍一下 mazi',
        baseline: { permissionCeiling: 'read-only' },
        variables: [{ kind: 'feature', label: 'concise', baseline: false, treatment: true }],
        arms: [
            { label: 'A', features: { concise: false } },
            { label: 'B', features: { concise: true } },
        ],
        ...(workspace !== undefined ? { workspace } : {}),
    };
}

describe('ExperimentsService', () => {
    it('create 只建两臂会话：停在实验专用运行时；不切换主会话工作区', async () => {
        const { service, requests, runtime } = await harnessWith('/project-a');
        const view = await service.create(specOf());
        expect(view.status).toBe('created');
        expect(view.arms.map((arm) => arm.status)).toEqual(['pending', 'pending']);
        expect(view.arms[0]?.rootGoalId).toBeTruthy();
        expect(requests).toHaveLength(0);
        // 走实验运行时；主会话的工作区选择完全没被碰过。
        expect(runtime.experimentHarnessCalls).toContain('/project-a');
        expect(runtime.workspaceCalls).toEqual([]);
        // 未显式给工作区时冻结当前选择进 spec（可复现 + 运行时实例一致）。
        expect(view.workspace).toBe('/project-a');
    });

    it('execute 前台并行执行两臂：completed + 对比 + 两臂 Feature 各自生效', async () => {
        const { service, requests } = await harnessWith();
        const planned = await service.create(specOf());
        const done = await service.execute(planned.experimentId);
        expect(done.status).toBe('completed');
        expect(done.arms.map((arm) => arm.status)).toEqual(['completed', 'completed']);
        expect(done.arms[0]?.metrics?.finalAnswer).toContain('A 答案');
        expect(done.arms[1]?.metrics?.finalAnswer).toContain('B 答案');
        expect(done.arms[1]?.metrics?.features).toEqual({ concise: true });
        expect(done.comparison?.outputs.identical).toBe(false);
        expect(requests).toHaveLength(2);
    });

    it('主会话在跑（chat 锁忙）时实验照样能跑：两把锁互不影响', async () => {
        const { service, runtime } = await harnessWith();
        const planned = await service.create(specOf());
        runtime.chatLockBusy = true;
        const done = await service.execute(planned.experimentId);
        expect(done.status).toBe('completed');
    });

    it('实验自己的锁忙 → 409；execute 幂等', async () => {
        const { service, runtime, requests } = await harnessWith();
        const planned = await service.create(specOf());
        runtime.experimentLockBusy = true;
        await expect(service.execute(planned.experimentId)).rejects.toThrow('已有实验在运行');
        runtime.experimentLockBusy = false;
        await service.execute(planned.experimentId);
        const again = await service.execute(planned.experimentId);
        expect(again.status).toBe('completed');
        expect(requests).toHaveLength(2);
    });

    it('臂 Trace 走实验独立端点：执行前 404，执行后可读快照与事件回放', async () => {
        const { service } = await harnessWith();
        const planned = await service.create(specOf());
        // 执行前：Goal 已建但还没有 Step 事实。
        const before = await service.armTimeline(planned.experimentId, 'A');
        expect(before.goals).toHaveLength(1);
        expect(before.stepCount).toBe(0);

        await service.execute(planned.experimentId);

        const snapshot = await service.armTimeline(planned.experimentId, 'A');
        expect(snapshot.stepCount).toBeGreaterThan(0);
        expect(snapshot.rootGoalId).toBe(planned.arms[0]?.rootGoalId);

        const { bus, rootGoalId } = await service.armBus(planned.experimentId, 'B');
        expect(rootGoalId).toBe(planned.arms[1]?.rootGoalId);
        expect((bus as DefaultEventBus).replay(rootGoalId).length).toBeGreaterThan(0);

        await expect(service.armTimeline(planned.experimentId, 'Z')).rejects.toThrow('实验臂不存在');
    });

    it('list/detail/review/remove 闭环；rerun 复制为新的待执行实验', async () => {
        const { service } = await harnessWith();
        const planned = await service.create(specOf());
        await service.execute(planned.experimentId);
        expect((await service.list()).experiments).toHaveLength(1);
        expect((await service.detail(planned.experimentId)).status).toBe('completed');

        const reviewed = await service.review(planned.experimentId, {
            note: ' B 更省 ',
            verdict: 'B',
        });
        expect(reviewed.reviews).toEqual([{ note: 'B 更省', verdict: 'B', at: expect.any(Number) }]);

        const rerun = await service.rerun(planned.experimentId);
        expect(rerun.experimentId).not.toBe(planned.experimentId);
        expect(rerun.status).toBe('created');
        expect((await service.list()).experiments).toHaveLength(2);

        expect(await service.remove(planned.experimentId)).toEqual({ ok: true, removed: true });
        await expect(service.detail(planned.experimentId)).rejects.toBeInstanceOf(ApiError);
        await expect(service.review('01ARZ3NDEKTSV4RRFFQ69G5FAV', { note: 'x' })).rejects.toThrow(
            '实验不存在',
        );
    });

    it('校验失败 → 400 语义；缺少 note → 400', async () => {
        const { service } = await harnessWith();
        await expect(service.create({ title: 't' })).rejects.toThrow(ApiError);
        await expect(service.create({ ...specOf(), arms: [{ label: 'A' }] })).rejects.toThrow(
            '恰好两个',
        );
        const planned = await service.create(specOf());
        await expect(service.review(planned.experimentId, {})).rejects.toThrow('缺少 note');
    });

    it('stop 随时终止：计划中的实验直接落 aborted，之后 execute 不会拉起', async () => {
        const { service, requests } = await harnessWith();
        const planned = await service.create(specOf());
        const stopped = await service.stop(planned.experimentId, {});
        expect(stopped.stopping).toEqual([]);
        expect(stopped.view.status).toBe('aborted');
        expect(stopped.view.arms.map((arm) => arm.status)).toEqual(['aborted', 'aborted']);
        expect(stopped.view.arms[0]?.metrics?.finalAnswer).toBe('用户终止');

        const run = await service.execute(planned.experimentId);
        expect(run.status).toBe('aborted');
        expect(requests).toHaveLength(0);
    });

    it('stop 终止正在运行的两臂：协作式停止，实验落 aborted 且带对比', async () => {
        const { service, runtime } = await harnessWith(undefined, { blocking: true });
        const planned = await service.create(specOf());
        const rootA = planned.arms[0]?.rootGoalId as string;
        const rootB = planned.arms[1]?.rootGoalId as string;
        const running = service.execute(planned.experimentId);
        await waitFor(
            () => runtime.rawHarness().isGoalRunning(rootA) && runtime.rawHarness().isGoalRunning(rootB),
        );

        const stopped = await service.stop(planned.experimentId, {});
        expect([...stopped.stopping].sort()).toEqual(['A', 'B']);

        const done = await running;
        expect(done.status).toBe('aborted');
        expect(done.arms.map((arm) => arm.status)).toEqual(['aborted', 'aborted']);
        expect(done.comparison).toBeDefined();
    });

    it('stop 支持单臂：只停指定 label，另一臂继续', async () => {
        const { service } = await harnessWith();
        const planned = await service.create(specOf());
        const stopped = await service.stop(planned.experimentId, { label: 'A' });
        expect(stopped.stopping).toEqual([]);
        expect(stopped.view.arms.map((arm) => arm.status)).toEqual(['aborted', 'pending']);

        const done = await service.execute(planned.experimentId);
        expect(done.arms[1]?.status).toBe('completed');
        expect(done.arms[0]?.status).toBe('aborted');
    });
});