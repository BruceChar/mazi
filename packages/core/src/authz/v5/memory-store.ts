/**
 * V5 指纹记忆存储（§8/D14）。
 *
 * 作用域 once / session / project：once 当次有效不跨次；session 限定会话；
 * project 全局。hazard 受限条目（不可逆 / envelope）禁止 project，只允许
 * once/session。内容哈希绑定：被绑对象改动即失效。
 */

export type MemoryScope = 'once' | 'session' | 'project';

export interface MemoryEntry {
    key: string;
    scope: MemoryScope;
    sessionId?: string;
    contentHash?: string;
    createdAt: number;
    /** hazard 类条目：不可逆 / envelope，作用域受限。 */
    hazardLimited: boolean;
}

export interface MemoryQuery {
    sessionId?: string;
    contentHash?: string;
}

export class MemoryStore {
    private readonly entries = new Map<string, MemoryEntry>();

    remember(entry: MemoryEntry): void {
        if (entry.scope === 'project' && entry.hazardLimited) {
            throw new Error('hazard 受限条目禁止 project 作用域（§5）');
        }
        this.entries.set(entry.key, entry);
    }

    has(key: string, ctx: MemoryQuery): boolean {
        const entry = this.entries.get(key);
        if (!entry) return false;
        if (entry.contentHash && ctx.contentHash && entry.contentHash !== ctx.contentHash) {
            return false;
        }
        if (entry.scope === 'once') return false;
        if (entry.scope === 'session') {
            return Boolean(ctx.sessionId) && entry.sessionId === ctx.sessionId;
        }
        return true;
    }

    /** 撤销某条；缺省清空全部，返回删除条数。 */
    revoke(key?: string): number {
        if (key === undefined) {
            const count = this.entries.size;
            this.entries.clear();
            return count;
        }
        return this.entries.delete(key) ? 1 : 0;
    }

    list(): readonly MemoryEntry[] {
        return [...this.entries.values()];
    }
}
