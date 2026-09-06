import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
    FlagSnapshot,
    Session,
    Step,
    Turn,
    TurnCheckpoint,
    UserInteractionRecord,
} from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createSchema } from './schema.js';
import { SqliteMemoryStore } from './sqlite-store.js';

/* ------------------------------------------------------------------ *
 * fixtures：构造最小 Session / Turn / Step / Record（JSON 可序列化）
 * ------------------------------------------------------------------ */

const NOW = 1_700_000_000_000;

/** 最小 FlagSnapshot（值与求值行为，语义与 @mazi/flags 冻结快照一致） */
function makeFlag(values: Record<string, unknown>): FlagSnapshot {
    return {
        values,
        trace: Object.keys(values).map((key) => ({ key, resolvedValue: values[key] })),
        isEnabled(key: string): boolean {
            return values[key] === true;
        },
        getNumber(key: string): number | undefined {
            return typeof values[key] === 'number' ? (values[key] as number) : undefined;
        },
        getString(key: string): string | undefined {
            return typeof values[key] === 'string' ? (values[key] as string) : undefined;
        },
    };
}

const SESSION_FLAGS: Record<string, unknown> = {
    'console.sink': true,
    'user-profile.enabled': true,
    'planner.routing-mode': 'simple',
};

/** 最小 GoalContract */
function makeGoal(sessionId: string, statement: string): Session['goal'] {
    return {
        goalId: `goal-${sessionId}`,
        sessionId,
        statement,
        success: { conditions: ['可机械判定的验收条件'], description: statement },
        constraints: [],
        allowedTools: [],
        permissionCeiling: 'read-only',
        budget: { maxTurns: 1, maxCostUsd: 0.5, reserveRatio: 0.2 },
        termination: { maxTurns: 1 },
        rollbackPolicy: { strategy: 'none' },
        strategyHints: ['simple'],
    };
}

/** 最小 SessionAggregate */
function makeAggregate(totalTurns: number): Session['aggregate'] {
    return {
        totalTurns,
        succeededTurns: 0,
        failedTurns: 0,
        rolledBackTurns: 0,
        totalSteps: 0,
        totalTokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
        totalCostUsd: 0,
        totalDurationMs: 0,
        contextStrategyInvocations: {
            truncate: 0,
            summarize: 0,
            retrieve: 0,
            compressObservation: 0,
            cachePromptPrefix: 0,
        },
    };
}

/** 最小 Session（不含持久化外字段） */
function makeSession(sessionId: string, turns: Turn[] = []): Session {
    return {
        sessionId,
        rawIntent: '帮我整理本周 TODO',
        goal: makeGoal(sessionId, '整理本周 TODO'),
        strategyId: 'full-loop',
        state: 'running',
        turns,
        aggregate: makeAggregate(turns.length),
        flagSnapshot: makeFlag(SESSION_FLAGS),
        createdAt: NOW,
    };
}

/** 最小 Capacity（带一个只读工具与 Flag 快照） */
function makeCapacity(): NonNullable<Turn['capacity']> {
    return {
        model: { providerId: 'scripted-a', vendor: 'scripted', modelId: 'scripted-1' },
        tools: [
            {
                name: 'fs.read',
                description: '读取文件',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
                minPermission: 'read-only',
                sideEffects: ['fs'],
            },
        ],
        permission: 'read-only',
        budget: { maxSteps: 3 },
        sandbox: { enabled: false },
        flags: makeFlag(SESSION_FLAGS),
    };
}

/** 最小 Turn */
function makeTurn(turnId: string, sessionId: string, withCapacity = true): Turn {
    const turn: Turn = {
        turnId,
        sessionId,
        contract: {
            turnContractId: `contract-${turnId}`,
            parentGoalId: `goal-${sessionId}`,
            parentPlanNodeId: 'plan-node-1',
            statement: `执行 ${turnId}`,
            tags: ['simple'],
            success: { conditions: ['done'] },
            failureSignals: [],
            requiredTools: [{ nameOrCapability: 'fs.read', required: true }],
            maxPermission: 'read-only',
            budget: { maxSteps: 3 },
            expectedSideEffects: [],
            rollback: { strategy: 'none' },
            termination: { maxSteps: 3 },
        },
        stepIds: [],
        status: 'pending',
        attempt: 1,
    };
    if (withCapacity) {
        turn.capacity = makeCapacity();
    }
    return turn;
}

/** thinking Step */
function thinkingStep(
    stepId: string,
    turnId: string,
    sessionId: string,
    seq: number,
    content = `第 ${seq} 步思考`,
): Step {
    return {
        stepId,
        turnId,
        sessionId,
        seq,
        kind: 'thinking',
        payload: { content },
        status: 'ok',
        startedAt: NOW + seq,
        endedAt: NOW + seq + 5,
        decisionContext: { contextSummary: content, capturedAt: NOW + seq + 1 },
    };
}

/** tool_call Step（带 model 与 decisionContext） */
function toolStep(stepId: string, turnId: string, sessionId: string, seq: number): Step {
    return {
        stepId,
        turnId,
        sessionId,
        seq,
        kind: 'tool_call',
        payload: { toolName: 'fs.read', arguments: { path: 'README.md' }, callId: 'call-1' },
        model: { providerId: 'scripted-a', vendor: 'scripted', modelId: 'scripted-1' },
        status: 'ok',
        startedAt: NOW + seq,
        endedAt: NOW + seq + 40,
        decisionContext: { contextSummary: '读文件', capturedAt: NOW + seq + 2 },
    };
}

/** observation Step（可选带完整 Usage） */
function observationStep(
    stepId: string,
    turnId: string,
    sessionId: string,
    seq: number,
    usage?: Step['usage'],
): Step {
    const step: Step = {
        stepId,
        turnId,
        sessionId,
        seq,
        kind: 'observation',
        payload: { toolName: 'fs.read', content: 'file content of README.md', isError: false },
        status: 'ok',
        startedAt: NOW + seq,
        endedAt: NOW + seq + 10,
        decisionContext: { contextSummary: '观察结果', capturedAt: NOW + seq + 3 },
    };
    if (usage !== undefined) {
        step.usage = usage;
    }
    return step;
}

/** 最小完整 Usage（vendor + runtime + cost + timing 四段） */
function makeUsage(): Step['usage'] {
    return {
        vendor: { inputTokens: 100, outputTokens: 50, reportedByVendor: false },
        runtime: {
            systemPromptTokens: 10,
            systemPromptRatio: 0.1,
            historyTokens: 20,
            toolSchemaTokens: 5,
            newInputTokens: 65,
            observationTokens: 0,
            retrievedTokens: 0,
            exampleTokens: 0,
            totalContextTokens: 100,
            contextWindowUtilization: 0.1,
            contextDeltaFromPrev: 0,
            strategyApplied: [],
        },
        cost: {
            inputCostUsd: 0.00005,
            outputCostUsd: 0.000075,
            cacheWriteCostUsd: 0,
            cacheReadCostUsd: 0,
            reasoningCostUsd: 0,
            totalCostUsd: 0.000125,
            priceTierApplied: 'base',
            pricingVersion: '0.0.0-scripted',
            currency: 'USD',
            calculatedAt: NOW,
        },
        timing: { ttftMs: 80, totalMs: 300, tokensPerSecond: 500 },
    };
}

/** 最小 TurnCheckpoint */
function makeCheckpoint(): TurnCheckpoint {
    return {
        lastCompletedStepSeq: 1,
        pendingStepIds: ['st-pending'],
        accumulatedUsage: { input: 120, output: 60, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
        accumulatedCostUsd: 0.0002,
        savedAt: NOW + 400,
    };
}

interface RecordOpts {
    userId?: string;
    status?: 'recording' | 'completed';
    updatedAt?: number;
    tags?: string[];
}

/** 最小 UserInteractionRecord（始终带 tags，保证与落盘 '[]' 语义一致） */
function makeRecord(
    recordId: string,
    sessionId: string,
    opts: RecordOpts = {},
): UserInteractionRecord {
    const record: UserInteractionRecord = {
        recordId,
        sessionId,
        rawInput: '查一下明天的天气',
        inputTimestamp: NOW,
        thoughtTrace: [{ stepSeq: 1, summary: '规划查询', category: 'planning' }],
        actionTrace: [
            { stepSeq: 2, actionType: 'tool_call', description: '调用天气工具', result: 'ok' },
        ],
        feedback: [{ timestamp: NOW + 10, type: 'output_rating', rating: 5 }],
        outcome: { status: 'success', summary: '查询完成' },
        tags: opts.tags ?? ['weather'],
        metrics: { durationMs: 100, totalTokens: 10, totalCostUsd: 0.01, turnCount: 1 },
        status: opts.status ?? 'completed',
        updatedAt: opts.updatedAt ?? NOW + 50,
    };
    if (opts.userId !== undefined) {
        record.userId = opts.userId;
    }
    return record;
}

/* ------------------------------------------------------------------ *
 * 测试主体
 * ------------------------------------------------------------------ */

describe('SqliteMemoryStore（MVP v1.0 §8 F8 / D1 node:sqlite）', () => {
    const stores: SqliteMemoryStore[] = [];
    const dirs: string[] = [];

    afterEach(() => {
        for (const store of stores) {
            store.close();
        }
        for (const dir of dirs) {
            rmSync(dir, { recursive: true, force: true });
        }
        stores.length = 0;
        dirs.length = 0;
    });

    /** 内存库实例（缺省 dbPath） */
    const mem = (): SqliteMemoryStore => {
        const store = new SqliteMemoryStore();
        stores.push(store);
        return store;
    };

    it('session/turn/step roundtrip：JSON 字段深度相等，loadSession 水合 turns 且 stepIds 由 steps 表回填', async () => {
        const store = mem();
        const turn = makeTurn('turn-rt-1', 's-rt-1');
        const session = makeSession('s-rt-1', [turn]);
        const st1 = thinkingStep('st-rt-1', 'turn-rt-1', 's-rt-1', 1);
        const st2 = toolStep('st-rt-2', 'turn-rt-1', 's-rt-1', 2);
        const st3 = observationStep('st-rt-3', 'turn-rt-1', 's-rt-1', 3, makeUsage());
        await store.saveStep(st1);
        await store.saveStep(st2);
        await store.saveStep(st3);
        await store.saveSession(session);

        const loaded = await store.loadSession('s-rt-1');
        expect(loaded).toBeDefined();
        const l = loaded as Session;
        expect(l.rawIntent).toBe(session.rawIntent);
        expect(l.strategyId).toBe('full-loop');
        expect(l.goal).toEqual(session.goal);
        expect(l.aggregate).toEqual(session.aggregate);
        // flagSnapshot：values/trace 深等，且重建后方法可调用
        expect(l.flagSnapshot.values).toEqual(session.flagSnapshot.values);
        expect(l.flagSnapshot.trace).toEqual(session.flagSnapshot.trace);
        expect(l.flagSnapshot.isEnabled('user-profile.enabled')).toBe(true);
        expect(l.flagSnapshot.getString('planner.routing-mode')).toBe('simple');
        // turns 水合（saveSession 级联落 Turn）
        expect(l.turns).toHaveLength(1);
        const lt = l.turns[0];
        // stepIds 从 steps 表回填，且按 seq 排序（Turn 落库时 stepIds 仍为空）
        expect(lt.stepIds).toEqual(['st-rt-1', 'st-rt-2', 'st-rt-3']);
        expect(lt.contract).toEqual(turn.contract);
        expect(lt.status).toBe('pending');
        expect(lt.attempt).toBe(1);
        expect(lt.capacity?.model).toEqual(turn.capacity?.model);
        expect(lt.capacity?.flags.values).toEqual(turn.capacity?.flags.values);
        // steps：payload / model / usage / decisionContext 均经 JSON 深度相等
        const steps = await store.listSteps('turn-rt-1');
        expect(steps).toHaveLength(3);
        expect(steps[0]).toEqual(st1);
        expect(steps[1]).toEqual(st2);
        expect(steps[2].payload).toEqual(st3.payload);
        expect(steps[2].usage).toEqual(st3.usage);
        expect(steps[2].decisionContext).toEqual(st3.decisionContext);
    });

    it('边界：loadSession 未知 id → undefined；saveSession 同 id 二次保存覆盖为最新字段', async () => {
        const store = mem();
        expect(await store.loadSession('missing-session')).toBeUndefined();
        const s1 = makeSession('s-up-1');
        await store.saveSession(s1);
        expect((await store.loadSession('s-up-1'))?.state).toBe('running');

        const s2 = makeSession('s-up-1');
        s2.state = 'succeeded';
        s2.outcome = 'success';
        s2.endedAt = NOW + 500;
        await store.saveSession(s2);
        const loaded = await store.loadSession('s-up-1');
        expect(loaded?.state).toBe('succeeded');
        expect(loaded?.outcome).toBe('success');
        expect(loaded?.endedAt).toBe(NOW + 500);
        expect(loaded?.rawIntent).toBe(s1.rawIntent);
    });

    it('saveTurn UPSERT：同 turnId 重复保存不产生重复行并覆盖；listTurns 按会话隔离', async () => {
        const store = mem();
        const t1 = makeTurn('turn-up-1', 'sess-turn-a', false);
        await store.saveTurn(t1);
        await store.saveTurn(makeTurn('turn-other', 'sess-turn-b', false));
        expect(await store.listTurns('sess-turn-a')).toHaveLength(1);
        expect(await store.listTurns('sess-turn-b')).toHaveLength(1);
        expect(await store.listTurns('empty-session')).toEqual([]);
        // 重存覆盖：status/attempt/stepIds/checkpoint
        const updated = makeTurn('turn-up-1', 'sess-turn-a', false);
        updated.status = 'running';
        updated.attempt = 2;
        updated.stepIds = ['st-a', 'st-b'];
        updated.checkpoint = makeCheckpoint();
        await store.saveTurn(updated);
        const turns = await store.listTurns('sess-turn-a');
        expect(turns).toHaveLength(1);
        expect(turns[0].status).toBe('running');
        expect(turns[0].attempt).toBe(2);
        expect(turns[0].stepIds).toEqual(['st-a', 'st-b']);
        expect(turns[0].checkpoint).toEqual(makeCheckpoint());
        expect(turns[0].contract).toEqual(updated.contract);
    });

    it('saveCheckpoint/loadCheckpoint：缺失 Turn → undefined，重复保存覆盖', async () => {
        const store = mem();
        expect(await store.loadCheckpoint('no-such-turn')).toBeUndefined();
        await store.saveTurn(makeTurn('turn-cp-1', 'sess-cp', false));
        // Turn 已落库但从未写过断点
        expect(await store.loadCheckpoint('turn-cp-1')).toBeUndefined();
        const cp1 = makeCheckpoint();
        await store.saveCheckpoint('turn-cp-1', cp1);
        expect(await store.loadCheckpoint('turn-cp-1')).toEqual(cp1);
        const cp2: TurnCheckpoint = {
            ...cp1,
            lastCompletedStepSeq: 3,
            pendingStepIds: [],
            savedAt: NOW + 800,
        };
        await store.saveCheckpoint('turn-cp-1', cp2);
        expect(await store.loadCheckpoint('turn-cp-1')).toEqual(cp2);
    });

    it('文件库：close 后第二次 open 同一文件，session/turn/step/checkpoint/record 数据仍在', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-memory-'));
        dirs.push(dir);
        const file = join(dir, 'store.db');
        const store1 = new SqliteMemoryStore(file);
        stores.push(store1);
        const turn = makeTurn('turn-file-1', 's-file-1');
        await store1.saveStep(thinkingStep('st-file-1', 'turn-file-1', 's-file-1', 1));
        await store1.saveStep(observationStep('st-file-2', 'turn-file-1', 's-file-1', 2));
        await store1.saveSession(makeSession('s-file-1', [turn]));
        await store1.saveCheckpoint('turn-file-1', makeCheckpoint());
        const rec = makeRecord('rec-file-1', 's-file-1', { userId: 'u-file', status: 'recording' });
        await store1.saveUserInteractionRecord(rec);
        store1.close();
        store1.close(); // close 幂等

        const store2 = new SqliteMemoryStore(file);
        stores.push(store2);
        const loaded = await store2.loadSession('s-file-1');
        expect(loaded?.rawIntent).toBe('帮我整理本周 TODO');
        expect(loaded?.turns).toHaveLength(1);
        expect(loaded?.turns[0].stepIds).toEqual(['st-file-1', 'st-file-2']);
        expect(await store2.loadCheckpoint('turn-file-1')).toEqual(makeCheckpoint());
        expect(await store2.loadUserInteractionRecord('rec-file-1')).toEqual(rec);
        expect(await store2.loadUserInteractionBySession('s-file-1')).toEqual(rec);
        expect(await store2.listSteps('turn-file-1')).toHaveLength(2);
    });

    it('user_interactions：save/load/bySession/list 过滤、排序与 limit（按 updated_at DESC）', async () => {
        const store = mem();
        const rA = makeRecord('rec-a', 'sess-u1', { userId: 'u1', updatedAt: NOW + 300 });
        const rB = makeRecord('rec-b', 'sess-u1', {
            userId: 'u1',
            status: 'recording',
            updatedAt: NOW + 100,
        });
        const rC = makeRecord('rec-c', 'sess-u1', { userId: 'u2', updatedAt: NOW + 200 });
        const rD = makeRecord('rec-d', 'sess-u2', { userId: 'u2', updatedAt: NOW + 400 });
        // 乱序插入：排序必须依赖 updated_at 而非插入顺序
        await store.saveUserInteractionRecord(rC);
        await store.saveUserInteractionRecord(rA);
        await store.saveUserInteractionRecord(rB);
        await store.saveUserInteractionRecord(rD);

        expect(await store.loadUserInteractionRecord('rec-a')).toEqual(rA);
        expect(await store.loadUserInteractionRecord('ghost-record')).toBeUndefined();
        // bySession 取该 Session 最新一条
        expect(await store.loadUserInteractionBySession('sess-u1')).toEqual(rA);
        expect(await store.loadUserInteractionBySession('sess-empty')).toBeUndefined();

        const ids = async (
            opts?: Parameters<SqliteMemoryStore['listUserInteractionRecords']>[0],
        ): Promise<string[]> =>
            (await store.listUserInteractionRecords(opts)).map((r) => r.recordId);
        expect(await ids()).toEqual(['rec-d', 'rec-a', 'rec-c', 'rec-b']);
        expect(await ids({ userId: 'u1' })).toEqual(['rec-a', 'rec-b']);
        expect(await ids({ status: 'recording' })).toEqual(['rec-b']);
        expect(await ids({ userId: 'u2', status: 'completed' })).toEqual(['rec-d', 'rec-c']);
        expect(await ids({ limit: 2 })).toEqual(['rec-d', 'rec-a']);
        expect(await ids({ limit: 1, status: 'completed' })).toEqual(['rec-d']);
        expect(await ids({ userId: 'nobody' })).toEqual([]);
    });

    it('user_interactions UPSERT：同 recordId 重存覆盖（outcome/feedback/status/updatedAt）', async () => {
        const store = mem();
        const rec = makeRecord('rec-up-1', 'sess-up', { userId: 'u1', status: 'recording' });
        await store.saveUserInteractionRecord(rec);
        const done: UserInteractionRecord = {
            ...rec,
            status: 'completed',
            updatedAt: NOW + 999,
            outcome: { status: 'success', summary: '最终完成' },
            feedback: [
                ...rec.feedback,
                { timestamp: NOW + 900, type: 'text_feedback', content: '很好' },
            ],
        };
        await store.saveUserInteractionRecord(done);
        expect(await store.loadUserInteractionRecord('rec-up-1')).toEqual(done);
        // 旧状态不再命中 recording 过滤
        expect(
            (await store.listUserInteractionRecords({ status: 'recording' })).map(
                (r) => r.recordId,
            ),
        ).toEqual([]);
    });

    it('saveStep 幂等（同 stepId 覆盖）且 listSteps 按 seq 升序；不同 stepId 同 seq 共存', async () => {
        const store = mem();
        await store.saveTurn(makeTurn('turn-steps', 'sess-steps', false));
        // 乱序落库：seq 2 → 0 → 1
        await store.saveStep(thinkingStep('st-3', 'turn-steps', 'sess-steps', 2));
        await store.saveStep(thinkingStep('st-1', 'turn-steps', 'sess-steps', 0));
        await store.saveStep(thinkingStep('st-2', 'turn-steps', 'sess-steps', 1));
        let steps = await store.listSteps('turn-steps');
        expect(steps.map((s) => s.stepId)).toEqual(['st-1', 'st-2', 'st-3']);
        expect(steps.map((s) => s.seq)).toEqual([0, 1, 2]);
        expect(await store.listSteps('no-such-turn')).toEqual([]);
        // 同 stepId 重存 → 幂等覆盖，不新增行
        await store.saveStep(thinkingStep('st-2', 'turn-steps', 'sess-steps', 1, '覆盖后的思考'));
        steps = await store.listSteps('turn-steps');
        expect(steps).toHaveLength(3);
        expect(steps[1].payload).toEqual({ content: '覆盖后的思考' });
        // 唯一性以 stepId 为准：不同 stepId 相同 seq 可共存
        await store.saveStep(thinkingStep('st-2b', 'turn-steps', 'sess-steps', 1, '备选思考'));
        steps = await store.listSteps('turn-steps');
        expect(steps).toHaveLength(4);
        expect(steps.filter((s) => s.seq === 1)).toHaveLength(2);
    });

    it('createSchema 幂等：重复调用安全，四表齐全且含目标五索引', () => {
        const db = new DatabaseSync(':memory:');
        createSchema(db);
        createSchema(db);
        const tables = (
            db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .all() as { name: string }[]
        ).map((row) => row.name);
        expect(tables).toEqual(['sessions', 'steps', 'turns', 'user_interactions']);
        const indexes = (
            db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name",
                )
                .all() as { name: string }[]
        ).map((row) => row.name);
        expect(indexes).toEqual([
            'idx_steps_turn_id',
            'idx_steps_turn_id_seq',
            'idx_turns_session_id',
            'idx_user_interactions_session_id',
            'idx_user_interactions_user_id',
        ]);
        db.close();
    });

    it('异常：close 后继续写入 rejected；close 幂等不抛；空库各查询返回空/undefined', async () => {
        const store = mem();
        expect(await store.listTurns('x')).toEqual([]);
        expect(await store.listSteps('x')).toEqual([]);
        expect(await store.loadSession('x')).toBeUndefined();
        await store.saveSession(makeSession('s-closed'));
        store.close();
        store.close();
        await expect(store.saveSession(makeSession('s-closed'))).rejects.toThrow();
        await expect(store.saveTurn(makeTurn('t', 's-closed', false))).rejects.toThrow();
        await expect(store.listSteps('x')).rejects.toThrow();
    });
});
