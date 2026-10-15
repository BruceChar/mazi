import { describe, expect, it } from 'vitest';
import type { IterationRecordView, SystemVersionRef } from '@mazi/libs';
import {
    type IterationStore,
    MemoryIterationStore,
    SqliteIterationStore,
} from '../src/analysis/iteration-store.js';

const BASE: SystemVersionRef = { version: 'v1.0.0', commit: 'abc1234', branch: 'main', dirty: false };

function record(
    iterationId: string,
    overrides: Partial<IterationRecordView> = {},
): IterationRecordView {
    return {
        iterationId,
        title: `title-${iterationId}`,
        intent: '',
        status: 'proposed',
        base: BASE,
        notes: '',
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

const factories: ReadonlyArray<readonly [string, () => IterationStore]> = [
    ['memory', () => new MemoryIterationStore()],
    ['sqlite', () => new SqliteIterationStore(':memory:')],
];

describe.each(factories)('IterationStore (%s)', (_name, create) => {
    it('save 后可按 iterationId load', async () => {
        const store = create();
        await store.save(record('it1', { intent: '改进提示词', notes: 'note' }));
        expect(await store.load('it1')).toMatchObject({
            iterationId: 'it1',
            intent: '改进提示词',
            notes: 'note',
        });
        expect(await store.load('missing')).toBeUndefined();
        store.close();
    });

    it('list 按 updatedAt 倒序（与落库顺序无关）', async () => {
        const store = create();
        await store.save(record('it1', { updatedAt: 10 }));
        await store.save(record('it2', { updatedAt: 30 }));
        await store.save(record('it3', { updatedAt: 20 }));
        expect((await store.list()).map((item) => item.iterationId)).toEqual([
            'it2',
            'it3',
            'it1',
        ]);
        store.close();
    });

    it('listByAnalyze 只返回同来源分析的记录', async () => {
        const store = create();
        await store.save(record('it1', { analyzeId: 'a1', updatedAt: 1 }));
        await store.save(record('it2', { analyzeId: 'a2', updatedAt: 2 }));
        await store.save(record('it3', { analyzeId: 'a1', updatedAt: 3 }));
        expect((await store.listByAnalyze('a1')).map((item) => item.iterationId)).toEqual([
            'it3',
            'it1',
        ]);
        expect(await store.listByAnalyze('a9')).toEqual([]);
        store.close();
    });
});
