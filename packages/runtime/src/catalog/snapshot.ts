/**
 * catalog/snapshot —— 运行时快照持有者：按 epoch 从事实整体重建，原子指针交换（双缓冲）。
 * 运行时层易失：重启后由 store 事实重建；在途请求各自持有派发时钉死的三元组，不受换代影响。
 */

import type { CatalogSnapshot } from '@mazi/core';
import { buildCatalogSnapshot } from '@mazi/core';
import type { CatalogFacts } from './state.js';
import { cloneCatalogFacts } from './state.js';

export class CatalogRuntime {
    private factsValue: CatalogFacts;
    private snapshotValue: CatalogSnapshot;

    constructor(facts: CatalogFacts, at: number = Date.now()) {
        this.factsValue = cloneCatalogFacts(facts);
        this.snapshotValue = buildCatalogSnapshot(this.factsValue, at);
    }

    /** 当前快照（只读视图；构建后不再修改，可安全并发读取）。 */
    current(): CatalogSnapshot {
        return this.snapshotValue;
    }

    epoch(): number {
        return this.snapshotValue.epoch;
    }

    facts(): CatalogFacts {
        return this.factsValue;
    }

    /**
     * 用新事实整体重建快照并一次赋值完成交换。
     * 旧快照对象保持不可变，仍被在途请求引用；新请求读到新快照。
     */
    rebuild(facts: CatalogFacts, at: number = Date.now()): CatalogSnapshot {
        const nextFacts = cloneCatalogFacts(facts);
        const nextSnapshot = buildCatalogSnapshot(nextFacts, at);
        this.factsValue = nextFacts;
        this.snapshotValue = nextSnapshot;
        return nextSnapshot;
    }
}
