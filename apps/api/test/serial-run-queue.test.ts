import { describe, expect, it } from 'vitest';
import { SerialRunQueue } from '../src/common/serial-run-queue.js';

describe('SerialRunQueue', () => {
    it('按到达顺序串行执行，后一个任务等待前一个结束', async () => {
        const queue = new SerialRunQueue();
        const events: string[] = [];
        let releaseFirst: () => void = () => {};
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = queue.run(async () => {
            events.push('first:start');
            await firstGate;
            events.push('first:end');
            return 'first';
        });
        const second = queue.run(async () => {
            events.push('second:start');
            return 'second';
        });

        await Promise.resolve();
        expect(events).toEqual(['first:start']);
        expect(queue.pendingCount).toBe(1);

        releaseFirst();
        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('前一个任务失败不会阻塞后续任务', async () => {
        const queue = new SerialRunQueue();
        const first = queue.run(async () => {
            throw new Error('boom');
        });
        const second = queue.run(async () => 'ok');

        await expect(first).rejects.toThrow('boom');
        await expect(second).resolves.toBe('ok');
    });

    it('关闭时拒绝所有尚未开始的任务', async () => {
        const queue = new SerialRunQueue();
        let releaseFirst: () => void = () => {};
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const first = queue.run(async () => {
            await firstGate;
            return 'first';
        });
        const second = queue.run(async () => 'second');

        queue.close(new Error('shutdown'));
        await expect(second).rejects.toThrow('shutdown');
        releaseFirst();
        await expect(first).resolves.toBe('first');
    });
});
