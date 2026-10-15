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

describe('ExperimentRunner（两臂顺序执行 + 冻结基线）', () => {
    it('两臂各跑一次 Goal，Feature 只影响对应臂；写入 completed 与 comparison', async () => {
        const { runner, store, requests } = setup();
        const view = await runner.run(specOf());

        expect(view.status).toBe('completed');
        expect(view.arms.map((arm) => arm.status)).toEqual(['completed', 'completed']);
        expect(view.arms[0]?.rootGoalId).toBeTruthy();
        expect(view.arms[1]?.rootGoalId).toBeTruthy();
        expect(view.arms[0]?.rootGoalId).not.toBe(view.arms[1]?.rootGoalId);

        // 两臂确实带上了不同的 Feature 解析结果。
        expect(requests).toHaveLength(2);
        expect(String(requests[0]?.system)).not.toContain('简洁作答');
        expect(String(requests[1]?.system)).toContain('简洁作答');

        expect(view.arms[0]?.metrics?.finalAnswer).toContain('A 答案');
        expect(view.arms[1]?.metrics?.finalAnswer).toContain('B 答案');
        expect(view.arms[1]?.metrics?.features).toEqual({ concise: true });
        expect(view.comparison?.outputs.identical).toBe(false);
        expect(view.comparison?.execution).toBe('sequential');
        expect(view.comparison?.metrics.some((metric) => metric.key === 'costUsd')).toBe(true);

        const events = (await store.list())[0]?.map((event) => event.type) ?? [];
        expect(events).toEqual([
            'experiment.created',
            'experiment.started',
            'arm.started',
            'arm.ended',
            'arm.started',
            'arm.ended',
            'experiment.completed',
        ]);
    });

    it('rerun 生成新 experimentId，不覆盖原记录；history 倒序', async () => {
        const { runner, store } = setup();
        const first = await runner.run(specOf());
        const second = await runner.rerun(first.experimentId);
        expect(second?.experimentId).not.toBe(first.experimentId);
        expect(second?.status).toBe('completed');
        expect(second?.input).toBe(first.input);
        expect(second?.variables).toEqual(first.variables);
        expect((await store.list()).length).toBe(2);
        expect(await runner.rerun('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeUndefined();
    });

    it('create 阶段失败被隔离为该臂 failed，另一臂仍执行并产出对比', async () => {
        const { runner, requests } = setup();
        // 让第一次 createGoalSession 抛错：临时替换 harness 方法。
        const harness = (runner as unknown as { harness: HarnessRuntime }).harness;
        const original = harness.createGoalSession.bind(harness);
        let calls = 0;
        harness.createGoalSession = async (input: string, options) => {
            calls += 1;
            if (calls === 1) throw new Error('模型不可用');
            return original(input, options);
        };
        const view = await runner.run(specOf());
        expect(view.status).toBe('completed');
        expect(view.arms[0]?.status).toBe('failed');
        expect(view.arms[0]?.error).toContain('模型不可用');
        expect(view.arms[1]?.status).toBe('completed');
        expect(requests).toHaveLength(1);
        expect(view.comparison).toBeDefined();
    });
});
