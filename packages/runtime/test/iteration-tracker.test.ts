import { describe, expect, it } from 'vitest';
import type { IterationStatus, SystemVersionRef } from '@mazi/libs';
import { MemoryIterationStore } from '../src/analysis/iteration-store.js';
import {
    canTransition,
    ITERATION_STATUSES,
    IterationTracker,
} from '../src/analysis/iteration-tracker.js';

const BASE: SystemVersionRef = { version: 'v1.0.0', commit: 'abc1234', branch: 'main', dirty: false };
const APPLIED: SystemVersionRef = { version: 'v1.1.0', commit: 'def5678', branch: 'main', dirty: true };

/** 可控时钟：每次读取自增，便于断言 updatedAt 被 bump。 */
function tracker(now: () => number = () => 100) {
    return new IterationTracker({ store: new MemoryIterationStore(), now });
}

async function created(sut: IterationTracker, title = '收敛 TOC 提示词') {
    return sut.create({ title, base: BASE });
}

describe('canTransition / ITERATION_STATUSES（纯函数状态机）', () => {
    it('覆盖全部五种状态', () => {
        expect(ITERATION_STATUSES).toEqual([
            'proposed',
            'in_progress',
            'applied',
            'reverted',
            'rejected',
        ]);
    });

    it('允许设计的迁移与同状态空操作', () => {
        expect(canTransition('proposed', 'in_progress')).toBe(true);
        expect(canTransition('proposed', 'rejected')).toBe(true);
        expect(canTransition('in_progress', 'applied')).toBe(true);
        expect(canTransition('in_progress', 'rejected')).toBe(true);
        expect(canTransition('applied', 'reverted')).toBe(true);
        expect(canTransition('reverted', 'in_progress')).toBe(true);
        expect(canTransition('rejected', 'proposed')).toBe(true);
        expect(canTransition('applied', 'applied')).toBe(true);
    });

    it('拒绝未设计的状态跃迁', () => {
        expect(canTransition('proposed', 'applied')).toBe(false);
        expect(canTransition('applied', 'in_progress')).toBe(false);
        expect(canTransition('rejected', 'in_progress')).toBe(false);
    });
});

describe('IterationTracker', () => {
    it('create 落库 proposed，base 注入，createdAt === updatedAt，notes 空', async () => {
        const sut = tracker(() => 100);
        const record = await sut.create({
            title: '收敛 TOC 提示词',
            intent: '减少冗余输出',
            analyzeId: 'a1',
            tocId: 't1',
            base: BASE,
        });
        expect(record.iterationId).not.toBe('');
        expect(record.status).toBe('proposed');
        expect(record.base).toEqual(BASE);
        expect(record.intent).toBe('减少冗余输出');
        expect(record.analyzeId).toBe('a1');
        expect(record.tocId).toBe('t1');
        expect(record.notes).toBe('');
        expect(record.createdAt).toBe(100);
        expect(record.updatedAt).toBe(100);
        expect(await sut.list()).toEqual([record]);
    });

    it('create 缺省 intent 为空串、来源字段缺省', async () => {
        const record = await created(tracker());
        expect(record.intent).toBe('');
        expect(record.analyzeId).toBeUndefined();
        expect(record.tocId).toBeUndefined();
    });

    it('执行设计的全部合法迁移', async () => {
        const paths: ReadonlyArray<readonly IterationStatus[]> = [
            ['in_progress', 'applied', 'reverted', 'in_progress'],
            ['in_progress', 'rejected', 'proposed'],
            ['rejected', 'proposed'],
            ['in_progress', 'applied'],
        ];
        for (const path of paths) {
            const sut = tracker();
            const record = await created(sut);
            let current = record;
            for (const status of path) {
                current = await sut.update(current.iterationId, { status });
                expect(current.status).toBe(status);
            }
        }
    });

    it('非法迁移抛 invalid transition，状态不变', async () => {
        const sut = tracker();
        const record = await created(sut);
        await expect(sut.update(record.iterationId, { status: 'applied' })).rejects.toThrow(
            'invalid transition: proposed -> applied',
        );
        expect((await sut.list())[0]?.status).toBe('proposed');
    });

    it('applied 迁移注入应用版本快照', async () => {
        const sut = tracker();
        const record = await created(sut);
        await sut.update(record.iterationId, { status: 'in_progress' });
        const applied = await sut.update(record.iterationId, {
            status: 'applied',
            applied: APPLIED,
        });
        expect(applied.status).toBe('applied');
        expect(applied.applied).toEqual(APPLIED);
        expect(applied.base).toEqual(BASE);
    });

    it('未提供 applied 快照时不写入 applied', async () => {
        const sut = tracker();
        const record = await created(sut);
        await sut.update(record.iterationId, { status: 'in_progress' });
        const applied = await sut.update(record.iterationId, { status: 'applied' });
        expect(applied.applied).toBeUndefined();
    });

    it('title/intent/notes 更新并 bump updatedAt', async () => {
        let clock = 1;
        const sut = tracker(() => clock);
        const record = await created(sut);
        clock = 2;
        const updated = await sut.update(record.iterationId, {
            title: '新标题',
            intent: '新意图',
            notes: '复盘备注',
        });
        expect(updated.title).toBe('新标题');
        expect(updated.intent).toBe('新意图');
        expect(updated.notes).toBe('复盘备注');
        expect(updated.createdAt).toBe(1);
        expect(updated.updatedAt).toBe(2);
    });

    it('未知 id 抛 iteration not found', async () => {
        const sut = tracker();
        await expect(sut.update('nope', { notes: 'x' })).rejects.toThrow(
            'iteration not found: nope',
        );
    });
});
