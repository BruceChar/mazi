/**
 * memory/store.ts —— 记忆持久化端口（store 侧）。
 *
 * store 只负责与数据库 / 文件 / 向量库等存储实体交互，不理解上下文预算，也不决定
 * 该注入什么；记忆的调度策略由 memory.ts 承担。
 */

export type MemoryKind = 'turn' | 'summary' | 'fact' | (string & {});

/** 一条长期记忆的最小形态（与具体存储解耦）。 */
export interface MemoryItem {
    id: string;
    kind: MemoryKind;
    text: string;
    /** kind='turn' 时的会话角色。 */
    role?: 'user' | 'assistant';
    createdAt: number;
    rootGoalId?: string;
    conversationId?: string;
    tags?: readonly string[];
}

export interface MemoryQuery {
    rootGoalId?: string;
    conversationId?: string;
    /** 召回条数上限；token 预算由 memory 策略处理。 */
    limit?: number;
}

/** 记忆持久化端口：SQLite / JSON / 向量库等实现。 */
export interface MemoryStore {
    append(items: readonly MemoryItem[]): Promise<void>;
    recall(query: MemoryQuery): Promise<readonly MemoryItem[]>;
    clear(query: MemoryQuery): Promise<void>;
}

function matches(item: MemoryItem, query: MemoryQuery): boolean {
    if (query.rootGoalId !== undefined && item.rootGoalId !== query.rootGoalId) return false;
    if (query.conversationId !== undefined && item.conversationId !== query.conversationId) {
        return false;
    }
    return true;
}

/** 进程内实现（测试 / 轻量运行）；不跨进程持久化。 */
export class InMemoryMemoryStore implements MemoryStore {
    private readonly items = new Map<string, MemoryItem>();

    async append(items: readonly MemoryItem[]): Promise<void> {
        for (const item of items) this.items.set(item.id, structuredClone(item));
    }

    async recall(query: MemoryQuery): Promise<readonly MemoryItem[]> {
        return [...this.items.values()]
            .filter((item) => matches(item, query))
            .sort((a, b) => a.createdAt - b.createdAt)
            .map((item) => structuredClone(item));
    }

    async clear(query: MemoryQuery): Promise<void> {
        for (const [id, item] of [...this.items]) {
            if (matches(item, query)) this.items.delete(id);
        }
    }
}
