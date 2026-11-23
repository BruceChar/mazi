import { type IterationStore, SqliteIterationStore } from './iteration-store.js';
import { IterationTracker } from './iteration-tracker.js';
import { TocAnalyst, type TocAnalystDeps } from './toc-analyst.js';
import { SqliteTocStore, type TocStore } from './toc-store.js';

/**
 * AnalysisStack —— TOC 冻结分析与 Iterations 记录的组合根（独立于 Goal 坐标系）。
 *
 * 两个 store 只在此处存在，宿主只持有本栈；close 一次释放全部。
 */
export interface AnalysisStackDeps {
    dbPath?: string;
    snapshotOf: TocAnalystDeps['snapshotOf'];
    requestRound: TocAnalystDeps['requestRound'];
    resolveModelChoice: TocAnalystDeps['resolveModelChoice'];
    systemPrompt?: string;
    now?: () => number;
}

export class AnalysisStack {
    readonly toc: TocAnalyst;
    readonly iterations: IterationTracker;
    private readonly tocStore: TocStore;
    private readonly iterationStore: IterationStore;

    constructor(deps: AnalysisStackDeps) {
        const dbPath = deps.dbPath ?? ':memory:';
        this.tocStore = new SqliteTocStore(dbPath);
        this.iterationStore = new SqliteIterationStore(dbPath);
        this.toc = new TocAnalyst({
            store: this.tocStore,
            snapshotOf: deps.snapshotOf,
            requestRound: deps.requestRound,
            resolveModelChoice: deps.resolveModelChoice,
            ...(deps.systemPrompt !== undefined ? { systemPrompt: deps.systemPrompt } : {}),
            ...(deps.now !== undefined ? { now: deps.now } : {}),
        });
        this.iterations = new IterationTracker({ store: this.iterationStore });
    }

    close(): void {
        this.tocStore.close();
        this.iterationStore.close();
    }
}
