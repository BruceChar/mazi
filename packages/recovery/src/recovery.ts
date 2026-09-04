import type { MemoryStore, Turn, TurnCheckpoint } from '@mazi/core';
import type { Executor, TurnExecutionOutcome } from '@mazi/executor';

/**
 * Checkpoint 管理 + 断点续传（feature F11，MVP 文档 §3.2/§5.4/§6 A9）。
 *
 * 设计说明：Executor 具备“续跑”语义——每次执行都从 MemoryStore 重建已完成 Steps，
 * 因此恢复 = 加载持久化 Session/Turn（含 capacity 与 checkpoint），再次驱动 Executor
 * 从断点继续；已完成的 Step（status=ok）不会重复执行（幂等，验收 A9）。
 */
export class CheckpointManager {
    constructor(private readonly memory: MemoryStore) {}

    loadCheckpoint(turnId: string): Promise<TurnCheckpoint | undefined> {
        return this.memory.loadCheckpoint(turnId);
    }
}

export interface ResumedSession {
    sessionId: string;
    /** 找到并续跑完成的 running Turn；无待续 Turn 时为 undefined */
    outcome?: TurnExecutionOutcome;
    resumedTurn?: Turn;
}

/**
 * Session 级恢复调度：崩溃重启后调用，加载持久化 Session，
 * 找到唯一 running/pending 且持有 capacity 的 Turn 并从断点继续执行。
 */
export class SessionResumer {
    constructor(private readonly memory: MemoryStore) {}

    async resumeRunningTurn(sessionId: string, executor: Executor): Promise<ResumedSession> {
        const session = await this.memory.loadSession(sessionId);
        if (!session) {
            throw new Error(`恢复失败：session ${sessionId} 不存在`);
        }
        const running = session.turns.filter(
            (turn) =>
                (turn.status === 'running' || turn.status === 'pending') &&
                turn.capacity !== undefined,
        );
        const turn = running[0];
        if (!turn) {
            return { sessionId };
        }
        const outcome = await executor.executeTurn(
            turn,
            turn.capacity as Turn['capacity'] & object,
        );
        return { sessionId, outcome, resumedTurn: turn };
    }
}
