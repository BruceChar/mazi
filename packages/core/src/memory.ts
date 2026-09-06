import type { Session, Step, Turn, TurnCheckpoint } from './session.js';
import type { UserInteractionRecord } from './user-interaction.js';

/** 持久化存储接口（由 memory 包实现） */
export interface MemoryStore {
    saveSession(session: Session): Promise<void>;
    loadSession(sessionId: string): Promise<Session | undefined>;
    /** 级联删除 Session 及其 Turn/Step/用户交互记录 */
    deleteSession(sessionId: string): Promise<void>;
    saveTurn(turn: Turn): Promise<void>;
    listTurns(sessionId: string): Promise<Turn[]>;
    saveStep(step: Step): Promise<void>;
    listSteps(turnId: string): Promise<Step[]>;
    saveCheckpoint(turnId: string, checkpoint: TurnCheckpoint): Promise<void>;
    loadCheckpoint(turnId: string): Promise<TurnCheckpoint | undefined>;
    saveUserInteractionRecord(record: UserInteractionRecord): Promise<void>;
    loadUserInteractionRecord(recordId: string): Promise<UserInteractionRecord | undefined>;
    loadUserInteractionBySession(sessionId: string): Promise<UserInteractionRecord | undefined>;
    listUserInteractionRecords(opts?: {
        userId?: string;
        status?: 'recording' | 'completed';
        limit?: number;
    }): Promise<UserInteractionRecord[]>;
}
