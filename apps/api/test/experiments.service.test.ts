/**
 * ExperimentsService 编排（docs/AB测试设计.md §7/§8.2）。
 * 用真实 HarnessRuntime（注入离线 faux provider）+ 内存实验日志，覆盖执行/复盘/重跑/删除
 * 与工作区恢复；HTTP 契约由 experiments.controller.test.ts 覆盖。
 */

import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentSpec, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { resolveFeatures } from '@mazi/core';
import type { ExperimentStore, FeatureRuntime, RuntimeConfig } from '@mazi/runtime';
import { FeatureRuntime as FeatureRuntimeClass, MemoryExperimentStore, MemoryFeatureStore } from '@mazi/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/common/api-error.js';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';
import { ExperimentsService } from '../src/experiments/experiments.service.js';
import { HarnessRuntime } from '@mazi/runtime';

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

interface Harness {
    service: ExperimentsService;
    store: ExperimentStore;
    runtime: StubRuntime;
    requests: LLMRequest[];
}

/** 只暴露 ExperimentsService 需要的运行时能力；runExclusive 同真实语义（串行执行）。 */
class StubRuntime {
    selectedWorkspaceRoot: string | undefined;
    readonly workspaceCalls: Array<string | undefined> = [];
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
    experiments(): ExperimentStore {
        return this.storeInstance;
    }
    features(): Promise<FeatureRuntime> {
        return Promise.resolve(this.featureRuntime);
    }
    runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        return operation();
    }
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function harnessWith(initialWorkspace?: string): Promise<Harness> {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-exp-svc-'));
    dirs.push(dir);
    const requests: LLMRequest[] = [];
    const harnessRuntime = new HarnessRuntime(configIn(dir), {
        llmProviders: { default: branchingProvider(requests) },
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
    it('create 执行两臂：completed + 对比 + 两臂输出不同；Feature 只影响对应臂', async () => {
        const { service, store, requests } = await harnessWith();
        const view = await service.create(specOf());
        expect(view.status).toBe('completed');
        expect(view.arms.map((arm) => arm.status)).toEqual(['completed', 'completed']);
        expect(view.arms[0]?.metrics?.finalAnswer).toContain('A 答案');
        expect(view.arms[1]?.metrics?.finalAnswer).toContain('B 答案');
        expect(view.arms[1]?.metrics?.features).toEqual({ concise: true });
        expect(view.comparison?.outputs.identical).toBe(false);
        expect(String(requests[0]?.system)).not.toContain('简洁作答');
        expect(String(requests[1]?.system)).toContain('简洁作答');
        expect((await store.list()).length).toBe(1);
    });

    it('spec.workspace 只在本次执行生效，结束后恢复宿主选择', async () => {
        const previous = mkdtempSync(join(tmpdir(), 'mazi-ws-'));
        dirs.push(previous);
        const target = mkdtempSync(join(tmpdir(), 'mazi-ws-target-'));
        dirs.push(target);
        const { service, runtime } = await harnessWith(previous);
        await service.create(specOf(target));
        expect(runtime.workspaceCalls).toEqual([target, previous]);
        expect(runtime.selectedWorkspaceRoot).toBe(previous);
    });

    it('list/detail/review/rerun/remove 闭环；未知 id → 404', async () => {
        const { service } = await harnessWith();
        const view = await service.create(specOf());
        expect((await service.list()).experiments).toHaveLength(1);
        expect((await service.detail(view.experimentId)).title).toBe('Feature 增益');

        const reviewed = await service.review(view.experimentId, {
            note: ' B 更省 ',
            verdict: 'B',
        });
        expect(reviewed.reviews).toEqual([{ note: 'B 更省', verdict: 'B', at: expect.any(Number) }]);

        const rerun = await service.rerun(view.experimentId);
        expect(rerun.experimentId).not.toBe(view.experimentId);
        expect(rerun.status).toBe('completed');
        expect((await service.list()).experiments).toHaveLength(2);

        expect(await service.remove(view.experimentId)).toEqual({ ok: true, removed: true });
        await expect(service.detail(view.experimentId)).rejects.toBeInstanceOf(ApiError);
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
        const view = await service.create(specOf());
        await expect(service.review(view.experimentId, {})).rejects.toThrow('缺少 note');
    });

    it('runExclusive 忙 → 409 透传（不吞错）', async () => {
        const { service, runtime } = await harnessWith();
        runtime.runExclusive = async () => {
            throw new ApiError(409, '已有会话在运行，请稍候');
        };
        await expect(service.create(specOf())).rejects.toThrow('已有会话在运行');
    });
});
