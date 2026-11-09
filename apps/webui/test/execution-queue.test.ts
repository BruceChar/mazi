import { describe, expect, it } from 'vitest';
import {
    completeExecution,
    enqueueExecution,
    isExecutionQueued,
    queuedExecutionItems,
    showExecutionQueueCard,
} from '../src/scripts/execution-queue.ts';

const first = {
    rootGoalId: 'run-1',
    conversationId: 'conversation-1',
    input: 'first task',
};
const second = {
    rootGoalId: 'run-2',
    conversationId: 'conversation-1',
    input: 'second task',
};
const third = {
    rootGoalId: 'run-3',
    conversationId: 'conversation-2',
    input: 'third task',
};

describe('执行队列投影', () => {
    it('只有多个任务时才展示执行队列卡', () => {
        expect(showExecutionQueueCard([])).toBe(false);
        expect(showExecutionQueueCard([{ ...first, status: 'running' }])).toBe(false);
        expect(
            showExecutionQueueCard([
                { ...first, status: 'running' },
                { ...second, status: 'queued' },
            ]),
        ).toBe(true);
    });

    it('队列卡只投影 queued 项，不重复展示当前 running 任务', () => {
        const queue = enqueueExecution(enqueueExecution([], first), second);
        expect(queuedExecutionItems(queue)).toEqual([
            expect.objectContaining({ rootGoalId: 'run-2', status: 'queued' }),
        ]);
    });

    it('首个任务执行，后续任务按到达顺序排队', () => {
        const firstQueue = enqueueExecution([], first);
        const secondQueue = enqueueExecution(firstQueue, second);
        const thirdQueue = enqueueExecution(secondQueue, third);

        expect(thirdQueue.map((item) => [item.rootGoalId, item.status])).toEqual([
            ['run-1', 'running'],
            ['run-2', 'queued'],
            ['run-3', 'queued'],
        ]);
        expect(isExecutionQueued(thirdQueue, 'run-2')).toBe(true);
        expect(isExecutionQueued(thirdQueue, 'run-1')).toBe(false);
    });

    it('当前任务结束后只提升队首，后续任务继续排队', () => {
        const queue = enqueueExecution(enqueueExecution([], first), second);
        const afterSecond = enqueueExecution(queue, third);

        const completed = completeExecution(afterSecond, 'run-1');
        expect(completed.next?.rootGoalId).toBe('run-2');
        expect(completed.queue.map((item) => [item.rootGoalId, item.status])).toEqual([
            ['run-2', 'running'],
            ['run-3', 'queued'],
        ]);
    });

    it('排队任务先返回结果时留在队列，当前任务结束后跳过已完成项', () => {
        const queue = enqueueExecution(enqueueExecution([], first), second);
        const secondFinished = completeExecution(queue, 'run-2');
        expect(secondFinished.queue[1]?.finished).toBe(true);
        expect(secondFinished.next).toBeUndefined();

        const firstFinished = completeExecution(secondFinished.queue, 'run-1');
        expect(firstFinished.queue).toEqual([]);
        expect(firstFinished.next).toBeUndefined();
    });
});
