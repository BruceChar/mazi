import type { MemoryStore, UserInteractionRecord } from '@mazi/core';

/** 记录查询（MVP：按 session / userId 聚合前的基础查询，验收 A10/A20 数据源） */
export async function getRecordBySession(
    memory: MemoryStore,
    sessionId: string,
): Promise<UserInteractionRecord | undefined> {
    return memory.loadUserInteractionBySession(sessionId);
}

export async function listRecords(
    memory: MemoryStore,
    opts: { userId?: string; status?: 'recording' | 'completed'; limit?: number } = {},
): Promise<UserInteractionRecord[]> {
    return memory.listUserInteractionRecords(opts);
}
