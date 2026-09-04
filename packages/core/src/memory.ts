import type { Session, Step, Turn, TurnCheckpoint } from './session';
import type { UserInteractionRecord } from './user-interaction';

/** 持久化存储接口（由 memory 包实现） */
export interface MemoryStore {
    saveSession(session: Session): Promise<void>;
    loadSession(sessionId: string): Promise<Session | undefined>;
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
