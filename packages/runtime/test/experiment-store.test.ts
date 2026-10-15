import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExperimentMetrics, ExperimentSpec } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
    appendExperimentReview,
    foldExperiment,
    listExperiments,
    loadExperiment,
    summarizeExperiment,
} from '../src/experiment/fold.js';
import { FileExperimentStore, MemoryExperimentStore, newExperimentEvent } from '../src/experiment/store.js';

const EXPERIMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SECOND_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SPEC: ExperimentSpec = {
    title: '模型对照',
    input: '同一输入',
    baseline: { reasoningLevel: 'high' },
    variables: [{ kind: 'model', label: '模型', baseline: 'm1', treatment: 'm2' }],
    arms: [
        { label: 'A', modelId: 'm1' },
        { label: 'B', modelId: 'm2' },
    ],
};

function metrics(partial: Partial<ExperimentMetrics> = {}): ExperimentMetrics {
    return {
        ok: true,
        status: 'succeeded',
        tasks: 1,
        steps: 3,
        toolCalls: 1,
        modelRounds: 2,
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 0,
        costUsd: 0.001,
        durationMs: 120,
        ttftMs: 30,
        finalAnswer: '答案',
        finalAnswerChars: 2,
        models: ['m1'],
        skills: [],
        features: {},
        ...partial,
    };
}

describe('ExperimentStore（append-only JSONL）', () => {
    it('append/read/list/remove 往返', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-exp-store-'));
        dirs.push(dir);
        const store = new FileExperimentStore(dir);
        await store.append(newExperimentEvent(EXPERIMENT_ID, 'experiment.created', { spec: SPEC }, 1));
        await store.append(newExperimentEvent(EXPERIMENT_ID, 'experiment.started', {}, 2));
        expect((await store.read(EXPERIMENT_ID)).map((event) => event.type)).toEqual([
            'experiment.created',
            'experiment.started',
        ]);
        expect((await store.list()).length).toBe(1);
        expect(readdirSync(dir)).toEqual([EXPERIMENT_ID + '.jsonl']);
        expect(await store.remove(EXPERIMENT_ID)).toBe(true);
        expect(await store.remove(EXPERIMENT_ID)).toBe(false);
        expect(await store.read(EXPERIMENT_ID)).toEqual([]);
    });

    it('拒绝非法实验 id（防目录穿越）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-exp-store2-'));
        dirs.push(dir);
        const store = new FileExperimentStore(dir);
        await expect(
            store.append(newExperimentEvent('../escape', 'experiment.started', {})),
        ).rejects.toThrow();
        expect(await store.read('../../etc/passwd')).toEqual([]);
        expect(await store.remove('../escape')).toBe(false);
    });

    it('损坏行被跳过，正常行仍可读', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-exp-store3-'));
        dirs.push(dir);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
            join(dir, EXPERIMENT_ID + '.jsonl'),
            'not json\n' +
                JSON.stringify(newExperimentEvent(EXPERIMENT_ID, 'experiment.created', { spec: SPEC }, 1)) +
                '\n',
            'utf8',
        );
        const store = new FileExperimentStore(dir);
        expect((await store.read(EXPERIMENT_ID)).map((event) => event.type)).toEqual([
            'experiment.created',
        ]);
    });
});

describe('foldExperiment（重放复盘）', () => {
    async function seeded(log: 'completed' | 'reviewed' | 'failed'): Promise<MemoryExperimentStore> {
        const store = new MemoryExperimentStore();
        await store.append(newExperimentEvent(EXPERIMENT_ID, 'experiment.created', { spec: SPEC }, 1000));
        await store.append(newExperimentEvent(EXPERIMENT_ID, 'experiment.started', {}, 1010));
        await store.append(
            newExperimentEvent(EXPERIMENT_ID, 'arm.started', { label: 'A', rootGoalId: 'run-a', spec: SPEC }, 1020),
        );
        await store.append(
            newExperimentEvent(EXPERIMENT_ID, 'arm.ended', { label: 'A', status: 'completed', metrics: metrics() }, 1100),
        );
        await store.append(
            newExperimentEvent(EXPERIMENT_ID, 'arm.started', { label: 'B', rootGoalId: 'run-b', spec: SPEC }, 1110),
        );
        await store.append(
            newExperimentEvent(
                EXPERIMENT_ID,
                'arm.ended',
                { label: 'B', status: 'failed', metrics: metrics({ ok: false, status: 'failed' }) },
                1200,
            ),
        );
        if (log === 'completed') {
            await store.append(
                newExperimentEvent(EXPERIMENT_ID, 'experiment.completed', { comparison: { metrics: [], outputs: { a: 'x', b: 'y', identical: false }, execution: 'sequential', note: 'n' } }, 1210),
            );
        }
        if (log === 'reviewed') {
            await store.append(
                newExperimentEvent(EXPERIMENT_ID, 'experiment.completed', { comparison: { metrics: [], outputs: { a: 'x', b: 'y', identical: false }, execution: 'sequential', note: 'n' } }, 1210),
            );
            await store.append(
                newExperimentEvent(EXPERIMENT_ID, 'experiment.reviewed', { note: 'B 更省', verdict: 'B' }, 1300),
            );
        }
        if (log === 'failed') {
            await store.append(newExperimentEvent(EXPERIMENT_ID, 'experiment.failed', { error: '锁定冲突' }, 1210));
        }
        return store;
    }

    it('created 冻结 spec；arm 状态、rootGoalId、指标来自日志', async () => {
        const store = await seeded('completed');
        const view = await loadExperiment(store, EXPERIMENT_ID);
        expect(view?.status).toBe('completed');
        expect(view?.createdAt).toBe(1000);
        expect(view?.startedAt).toBe(1010);
        expect(view?.endedAt).toBe(1210);
        expect(view?.baseline.reasoningLevel).toBe('high');
        expect(view?.arms.map((arm) => [arm.label, arm.status, arm.rootGoalId])).toEqual([
            ['A', 'completed', 'run-a'],
            ['B', 'failed', 'run-b'],
        ]);
        expect(view?.arms[0]?.metrics?.costUsd).toBeCloseTo(0.001, 12);
        expect(view?.comparison?.outputs.identical).toBe(false);
    });

    it('复盘备注 append-only；重复折叠结果一致（无第二个真相源）', async () => {
        const store = await seeded('reviewed');
        const first = await loadExperiment(store, EXPERIMENT_ID);
        const second = await loadExperiment(store, EXPERIMENT_ID);
        expect(first).toEqual(second);
        expect(first?.reviews).toEqual([{ note: 'B 更省', verdict: 'B', at: 1300 }]);
        const updated = await appendExperimentReview(store, EXPERIMENT_ID, ' 再跑一次 ', 'tie', 1400);
        expect(updated?.reviews).toHaveLength(2);
        expect(updated?.reviews[1]).toEqual({ note: '再跑一次', verdict: 'tie', at: 1400 });
        expect(await appendExperimentReview(store, SECOND_ID, 'x', 'tie')).toBeUndefined();
    });

    it('整体失败 → status=failed + error；任一臂 aborted → status=aborted', async () => {
        const failed = await loadExperiment(await seeded('failed'), EXPERIMENT_ID);
        expect(failed?.status).toBe('failed');
        expect(failed?.error).toBe('锁定冲突');

        const store = new MemoryExperimentStore();
        await store.append(newExperimentEvent(SECOND_ID, 'experiment.created', { spec: SPEC }, 1));
        await store.append(newExperimentEvent(SECOND_ID, 'arm.started', { label: 'A' }, 2));
        await store.append(
            newExperimentEvent(SECOND_ID, 'arm.ended', { label: 'A', status: 'aborted', metrics: metrics({ ok: false, status: 'aborted' }) }, 3),
        );
        await store.append(newExperimentEvent(SECOND_ID, 'experiment.completed', {}, 4));
        expect((await loadExperiment(store, SECOND_ID))?.status).toBe('aborted');
    });

    it('无 created 事件 → undefined；list 按 createdAt 倒序', async () => {
        const store = new MemoryExperimentStore();
        expect(foldExperiment([newExperimentEvent(EXPERIMENT_ID, 'experiment.started', {})])).toBeUndefined();
        await store.append(newExperimentEvent(EXPERIMENT_ID, 'experiment.created', { spec: SPEC }, 1000));
        await store.append(newExperimentEvent(SECOND_ID, 'experiment.created', { spec: { ...SPEC, title: '新' } }, 2000));
        const list = await listExperiments(store);
        expect(list.map((view) => view.experimentId)).toEqual([SECOND_ID, EXPERIMENT_ID]);
    });

    it('summarize 只带轻量字段', async () => {
        const view = await loadExperiment(await seeded('completed'), EXPERIMENT_ID);
        const summary = summarizeExperiment(view as NonNullable<typeof view>);
        expect(summary).toMatchObject({ experimentId: EXPERIMENT_ID, title: '模型对照', status: 'completed' });
        expect(summary.arms[0]).toMatchObject({ label: 'A', rootGoalId: 'run-a', ok: true });
        expect(JSON.stringify(summary)).not.toContain('finalAnswer');
        expect(summary.reviewCount).toBe(0);
    });
});
