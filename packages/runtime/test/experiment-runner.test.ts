import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentSpec, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { resolveFeatures } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { ExperimentRunner } from '../src/experiment/runner.js';
import { MemoryExperimentStore } from '../src/experiment/store.js';
import { HarnessRuntime } from '../src/harness/index.js';

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

/** 按系统提示是否含 Feature 片段决定答案，用于验证两臂确实带着不同配置运行。 */
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

const FEATURE = {
    id: 'concise',
    name: '简洁作答',
    description: '先给结论',
    enabled: false,
    promptFragment: '简洁作答',
};

function specOf(): ExperimentSpec {
    return {
        title: 'Feature 增益',
        input: '介绍一下 mazi',
        baseline: { permissionCeiling: 'read-only' },
        variables: [{ kind: 'feature', label: 'concise', baseline: false, treatment: true }],
        arms: [
            { label: 'A', features: { concise: false } },
            { label: 'B', features: { concise: true } },
        ],
    };
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(): { runner: ExperimentRunner; store: MemoryExperimentStore; requests: LLMRequest[] } {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-exp-run-'));
    dirs.push(dir);
    const requests: LLMRequest[] = [];
    const runtime = new HarnessRuntime(configIn(dir), {
        llmProviders: { default: branchingProvider(requests) },
    });
    const store = new MemoryExperimentStore();
    const runner = new ExperimentRunner({
        harness: runtime,
        store,
        featureResolver: (overrides) => resolveFeatures([FEATURE], overrides),
        now: () => 5000,
    });
    return { runner, store, requests };
}

async function eventTypes(store: MemoryExperimentStore): Promise<string[]> {
    return ((await store.list())[0] ?? []).map((event) => event.type);
}

describe('ExperimentRunner（前台执行：plan → execute，两臂并行）', () => {
    it('create 只建两臂会话：status=created、两臂 pending 且各有 rootGoalId，不发模型请求', async () => {
        const { runner, store, requests } = setup();
        const view = await runner.create(specOf());
        expect(view.status).toBe('created');
        expect(view.arms.map((arm) => arm.status)).toEqual(['pending', 'pending']);
        expect(view.arms[0]?.rootGoalId).toBeTruthy();
        expect(view.arms[1]?.rootGoalId).toBeTruthy();
        expect(view.arms[0]?.rootGoalId).not.toBe(view.arms[1]?.rootGoalId);
        expect(requests).toHaveLength(0);
        expect(await eventTypes(store)).toEqual([
            'experiment.created',
            'arm.planned',
            'arm.planned',
        ]);
    });

    it('execute 前台并行跑完两臂：completed + 对比 + 各臂 Feature 生效', async () => {
        const { runner, store, requests } = setup();
        const planned = await runner.create(specOf());
        const done = await runner.execute(planned.experimentId);

        expect(done.status).toBe('completed');
        expect(done.arms.map((arm) => arm.status)).toEqual(['completed', 'completed']);
        expect(done.arms[0]?.metrics?.finalAnswer).toContain('A 答案');
        expect(done.arms[1]?.metrics?.finalAnswer).toContain('B 答案');
        expect(done.arms[1]?.metrics?.features).toEqual({ concise: true });
        expect(done.comparison?.outputs.identical).toBe(false);
        expect(done.comparison?.execution).toBe('sequential');

        // 两臂确实带上了不同的 Feature 解析结果。
        expect(requests).toHaveLength(2);
        const systems = requests.map((request) => String(request.system));
        expect(systems.some((system) => system.includes('简洁作答'))).toBe(true);
        expect(systems.some((system) => !system.includes('简洁作答'))).toBe(true);

        expect(await eventTypes(store)).toEqual([
            'experiment.created',
            'arm.planned',
            'arm.planned',
            'experiment.started',
            'arm.started',
            'arm.started',
            'arm.ended',
            'arm.ended',
            'experiment.completed',
        ]);
    });

    it('execute 幂等：已完成的臂不重跑', async () => {
        const { runner, requests } = setup();
        const planned = await runner.create(specOf());
        await runner.execute(planned.experimentId);
        const again = await runner.execute(planned.experimentId);
        expect(again.status).toBe('completed');
        expect(requests).toHaveLength(2);
    });

    it('run = create + execute（一次性入口）', async () => {
        const { runner } = setup();
        const view = await runner.run(specOf());
        expect(view.status).toBe('completed');
        expect(view.comparison).toBeDefined();
    });

    it('rerun 复制为新的待执行实验（不执行、不覆盖原记录）', async () => {
        const { runner, store } = setup();
        const first = await runner.run(specOf());
        const second = await runner.rerun(first.experimentId);
        expect(second?.experimentId).not.toBe(first.experimentId);
        expect(second?.status).toBe('created');
        expect(second?.arms.map((arm) => arm.status)).toEqual(['pending', 'pending']);
        expect(second?.input).toBe(first.input);
        expect(second?.variables).toEqual(first.variables);
        expect((await store.list()).length).toBe(2);
        expect(await runner.rerun('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeUndefined();
    });

    it('单臂执行失败被隔离：另一臂仍完成并产出对比', async () => {
        const { runner, requests } = setup();
        const planned = await runner.create(specOf());
        const harness = (runner as unknown as { harness: HarnessRuntime }).harness;
        const original = harness.executeGoalTree.bind(harness);
        let calls = 0;
        harness.executeGoalTree = async (rootGoalId: string) => {
            calls += 1;
            if (calls === 1) throw new Error('模型不可用');
            return original(rootGoalId);
        };
        const view = await runner.execute(planned.experimentId);
        expect(view.status).toBe('completed');
        expect(view.arms[0]?.status).toBe('failed');
        expect(view.arms[0]?.error).toContain('模型不可用');
        expect(view.arms[1]?.status).toBe('completed');
        expect(view.comparison).toBeDefined();
        expect(requests).toHaveLength(1);
    });

    it('history 按创建时间倒序', async () => {
        const { runner } = setup();
        await runner.create(specOf());
        await runner.create({ ...specOf(), title: '第二次' });
        const history = await runner.history();
        expect(history.map((view) => view.title)).toEqual(['第二次', 'Feature 增益']);
    });
});
