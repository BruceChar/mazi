import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';
import { MemoryBehaviorStore } from '../src/memory/behavior-store.js';
import {
    BehaviorRecorder,
    feedbackBehaviorRecords,
} from '../src/observability/behavior-recorder.js';
import { ApprovalBroker } from '../src/tool-gateway/approval.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function approvalRequest(rootGoalId: string, invocationId: string) {
    return {
        invocationId,
        tool: 'shell.run',
        capability: 'fs.exec',
        identifiers: { rootGoalId, goalId: rootGoalId, taskId: 't', stepId: 's' },
        echo: {
            invocationId,
            tool: 'shell.run',
            effectClass: 'fs.exec',
            dataflowSources: [],
            taintProvenance: [],
        },
        allowedScopes: ['once', 'session'] as const,
    };
}

describe('用户行为指令记录（UB-C）', () => {
    it('feedbackBehaviorRecords：rating 与 text 各自单独成条；空反馈保留占位', () => {
        expect(
            feedbackBehaviorRecords({
                type: 'output_rating',
                rating: 5,
                content: '很好',
                timestamp: 1,
            }),
        ).toEqual([
            { type: 'feedback', data: { kind: 'rating', rating: 5 } },
            { type: 'feedback', data: { kind: 'text', text: '很好' } },
        ]);
        expect(feedbackBehaviorRecords({ type: 'mystery', timestamp: 1 })).toEqual([
            { type: 'feedback', data: { kind: 'text' } },
        ]);
    });

    it('审批发起 → approval 锚点；用户授权 → authorization（含 latency 与 ref）', async () => {
        const store = new MemoryBehaviorStore(() => 1000);
        const recorder = new BehaviorRecorder(store);
        let clock = 1000;
        const broker = new ApprovalBroker({
            emit: (event: HarnessEvent) => {
                void recorder.handleApprovalEvent(event);
            },
            timeoutMs: 60_000,
            now: () => clock,
        });
        const pending = broker.decide(approvalRequest('rg', 'inv-1'));
        clock = 2500;
        broker.settle('inv-1', { decision: 'granted', scope: 'session' });
        await pending;
        await drain();

        const behaviors = await store.list('rg');
        expect(behaviors.map((b) => b.type)).toEqual(['approval', 'authorization']);
        expect(behaviors[0]?.data.invocationId).toBe('inv-1');
        expect(behaviors[1]?.data).toMatchObject({
            decision: 'granted',
            scope: 'session',
            latencyMs: 1500,
        });
        expect(behaviors[1]?.ref?.ts).toBe(behaviors[0]?.ts);
    });

    it('拒绝记为 denied；TTL 超时不记 authorization', async () => {
        const store = new MemoryBehaviorStore();
        const recorder = new BehaviorRecorder(store);
        const broker = new ApprovalBroker({
            emit: (event: HarnessEvent) => {
                void recorder.handleApprovalEvent(event);
            },
            timeoutMs: 60_000,
            now: () => 10,
        });
        const pending = broker.decide(approvalRequest('rg', 'inv-r'));
        broker.settle('inv-r', { decision: 'rejected', reason: 'no' });
        await pending;
        await drain();
        const rejected = await store.list('rg');
        expect(rejected.map((b) => b.type)).toEqual(['approval', 'authorization']);
        expect(rejected[1]?.data.decision).toBe('denied');

        const store2 = new MemoryBehaviorStore();
        const recorder2 = new BehaviorRecorder(store2);
        const broker2 = new ApprovalBroker({
            emit: (event: HarnessEvent) => {
                void recorder2.handleApprovalEvent(event);
            },
            timeoutMs: 5,
        });
        await broker2.decide(approvalRequest('rg2', 'inv-t'));
        await drain();
        expect((await store2.list('rg2')).map((b) => b.type)).toEqual(['approval']);
    });

    it('runtime：输入/反馈/审批事件全部落行为流', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-behavior-rt-'));
        dirs.push(dir);
        const config: RuntimeConfig = {
            providers: [],
            tools: [],
            dbPath: ':memory:',
            eventDir: dir,
            goal: { allowedTools: [], permissionCeiling: 'read-only' },
            contextWindow: 64000,
        };
        const runtime = new HarnessRuntime(config);
        const broker = new ApprovalBroker({
            emit: (event) => runtime.eventBus.emit(event),
            timeoutMs: 60_000,
        });
        try {
            const created = await runtime.createGoalSession('用户的问题');
            await runtime.recordFeedback(created.rootGoalId, {
                type: 'text_feedback',
                content: '太啰嗦',
                timestamp: 1,
            });
            const pending = broker.decide(approvalRequest(created.rootGoalId, 'inv-x'));
            broker.settle('inv-x', { decision: 'granted', scope: 'once' });
            await pending;
            await drain();

            const behaviors = await runtime.listBehaviors(created.rootGoalId);
            expect(behaviors.map((b) => b.type)).toEqual([
                'input',
                'feedback',
                'approval',
                'authorization',
            ]);
            expect(behaviors[0]?.data.text).toBe('用户的问题');
            expect(behaviors[1]?.data).toEqual({ kind: 'text', text: '太啰嗦' });
        } finally {
            await runtime.close();
        }
    });
});
