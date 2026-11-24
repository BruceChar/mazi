/**
 * V5 红线存储（§1 blocked）：用户显式否决过的操作，再次出现点名也问一次。
 * 与记忆相反：这是负向集合，不参与任何放行通道。
 */

export class BlockedStore {
    private readonly blocked = new Set<string>();

    add(key: string): void {
        this.blocked.add(key);
    }

    has(key: string): boolean {
        return this.blocked.has(key);
    }

    remove(key: string): void {
        this.blocked.delete(key);
    }

    clear(): void {
        this.blocked.clear();
    }

    list(): readonly string[] {
        return [...this.blocked];
    }
}
