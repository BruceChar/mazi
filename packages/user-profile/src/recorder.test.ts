import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStore, Session, Turn, TurnCheckpoint, UserInteractionRecord } from '@mazi/core';
import { DefaultEventBus, newHarnessEvent } from '@mazi/observability';
import { describe, expect, it } from 'vitest';
import { anonymizeText } from './anonymizer.js';
import { UserProfileRecorder } from './recorder.js';

class MemoryStub implements MemoryStore {
    records = new Map<string, UserInteractionRecord>();
    async saveUserInteractionRecord(r: UserInteractionRecord): Promise<void> {
        this.records.set(r.recordId, structuredClone(r));
    }
    async loadUserInteractionRecord(id: string): Promise<UserInteractionRecord | undefined> {
        return structuredClone(this.records.get(id));
    }
    async loadUserInteractionBySession(
        sessionId: string,
    ): Promise<UserInteractionRecord | undefined> {
        for (const r of this.records.values()) {
            if (r.sessionId === sessionId) {
                return structuredClone(r);
            }
        }
        return undefined;
    }
    async listUserInteractionRecords(opts?: {
        userId?: string;
        status?: 'recording' | 'completed';
        limit?: number;
    }): Promise<UserInteractionRecord[]> {
        const all = [...this.records.values()].filter(
            (r) =>
                (opts?.userId ? r.userId === opts.userId : true) &&
                (opts?.status ? r.status === opts.status : true),
        );
        all.sort((a, b) => b.updatedAt - a.updatedAt);
        return structuredClone(opts?.limit ? all.slice(0, opts.limit) : all);
    }
    async saveSession(): Promise<void> {}
    async loadSession(): Promise<Session | undefined> {
        return undefined;
    }
    async deleteSession(): Promise<void> {}
    async saveTurn(): Promise<void> {}
    async listTurns(): Promise<Turn[]> {
        return [];
    }
    async saveStep(): Promise<void> {}
    async listSteps(): Promise<never[]> {
        return [];
    }
    async saveCheckpoint(): Promise<void> {}
    async loadCheckpoint(): Promise<TurnCheckpoint | undefined> {
        return undefined;
    }
    async addFailureRecord(): Promise<void> {}
    async listFailureRecords(): Promise<never[]> {
        return [];
    }
}

const mkBus = () => new DefaultEventBus({ eventDir: mkdtempSync(join(tmpdir(), 'mazi-up-')) });

function startRecorder(
    bus: DefaultEventBus,
    memory: MemoryStore,
    opts: { enabled?: boolean; anonymize?: boolean } = {},
): UserProfileRecorder {
    const recorder = new UserProfileRecorder(bus, memory, {
        enabled: () => opts.enabled ?? true,
        anonymize: () => opts.anonymize ?? false,
        now: () => 1000,
    });
    recorder.start();
    return recorder;
}

describe('UserProfileRecorder（MVP v1.0 §8 F13 / 验收 A10）', () => {
    it('session.started 即时创建 recording 记录（原始输入保留），随后 step/feedback/session.ended 持续更新至 completed', async () => {
        const bus = mkBus();
        const mem = new MemoryStub();
        const recorder = startRecorder(bus, mem);
        const sessionId = 'sess-up';
        bus.emit(
            newHarnessEvent({
                type: 'session.started',
                sessionId,
                payload: { rawInput: '原始输入内容', inputTimestamp: 100, userId: 'u1' },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        let record = (await mem.loadUserInteractionBySession(sessionId)) as UserInteractionRecord;
        expect(record.status).toBe('recording');
        expect(record.rawInput).toBe('原始输入内容');
        expect(record.userId).toBe('u1');
        // thinking step
        bus.emit(
            newHarnessEvent({
                type: 'step.ended',
                sessionId,
                turnId: 't1',
                stepId: 's1',
                attributes: { 'harness.step_kind': 'thinking' },
                payload: { seq: 1, text: '我的推理过程很长很详细'.repeat(50) },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        record = (await mem.loadUserInteractionBySession(sessionId)) as UserInteractionRecord;
        expect(record.thoughtTrace).toHaveLength(1);
        expect(record.thoughtTrace[0]?.summary.length).toBeLessThanOrEqual(200);
        // tool_call step
        bus.emit(
            newHarnessEvent({
                type: 'step.ended',
                sessionId,
                turnId: 't1',
                stepId: 's2',
                attributes: { 'harness.step_kind': 'tool_call' },
                payload: { seq: 2, toolName: 'fs.read', result: 'ok' },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        // feedback
        bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                sessionId,
                payload: {
                    feedback: {
                        timestamp: 200,
                        type: 'output_rating',
                        rating: 5,
                        content: '满意',
                    },
                },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        // session ended
        bus.emit(
            newHarnessEvent({
                type: 'session.ended',
                sessionId,
                payload: {
                    outcome: { status: 'success', summary: '完成' },
                    metrics: {
                        durationMs: 100,
                        totalTokens: 50,
                        totalCostUsd: 0.001,
                        turnCount: 1,
                    },
                },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        record = (await mem.loadUserInteractionBySession(sessionId)) as UserInteractionRecord;
        expect(record.actionTrace).toHaveLength(1);
        expect(record.actionTrace[0]?.description).toContain('fs.read');
        expect(record.feedback).toHaveLength(1);
        expect(record.feedback[0]?.rating).toBe(5);
        expect(record.status).toBe('completed');
        expect(record.outcome?.status).toBe('success');
        expect(record.metrics.turnCount).toBe(1);
        recorder.stop();
    });

    it('anonymize=true：rawInput 脱敏、userId 省略；enabled=false 不生成记录', async () => {
        const bus = mkBus();
        const mem = new MemoryStub();
        const anon = startRecorder(bus, mem, { anonymize: true });
        bus.emit(
            newHarnessEvent({
                type: 'session.started',
                sessionId: 'sess-anon',
                payload: { rawInput: '秘密内容', inputTimestamp: 1, userId: 'u2' },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        const a = (await mem.loadUserInteractionBySession('sess-anon')) as UserInteractionRecord;
        expect(a.userId).toBeUndefined();
        expect(a.rawInput).not.toBe('秘密内容');
        expect(anonymizeText('秘密内容')).toBe(a.rawInput);
        anon.stop();

        const bus2 = mkBus();
        const mem2 = new MemoryStub();
        const disabled = startRecorder(bus2, mem2, { enabled: false });
        bus2.emit(
            newHarnessEvent({
                type: 'session.started',
                sessionId: 'sess-off',
                payload: { rawInput: 'x', inputTimestamp: 1 },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        expect(await mem2.loadUserInteractionBySession('sess-off')).toBeUndefined();
        disabled.stop();
    });

    it('session.started 事件后 emit user.input.recorded（含 recordId）', async () => {
        const bus = mkBus();
        const seen: string[] = [];
        bus.subscribe(
            { types: ['user.input.recorded'] },
            {
                id: 'spy',
                handle: (e) => {
                    seen.push(e.type);
                },
            },
        );
        const recorder = startRecorder(bus, new MemoryStub());
        bus.emit(
            newHarnessEvent({
                type: 'session.started',
                sessionId: 'sess-r',
                payload: { rawInput: 'hi', inputTimestamp: 1 },
            }),
        );
        await new Promise((r) => setTimeout(r, 5));
        expect(seen).toEqual(['user.input.recorded']);
        recorder.stop();
    });
});

describe('anonymizer', () => {
    it('同一输入得到稳定摘要且长度受限', () => {
        const a = anonymizeText('相同输入');
        expect(a).toBe(anonymizeText('相同输入'));
        expect(anonymizeText('另一个输入')).not.toBe(a);
        expect(a).toMatch(/^<anon:[0-9a-f]{16}>$/);
    });
});
