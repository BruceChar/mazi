import {
    MemoryBlackboardStore,
    ProjectBlackboardService,
    SqliteBlackboardStore,
} from '../blackboard/index.js';
import type { RuntimeConfig } from '../config.js';
import type { EffectStore } from '../effects/effect-store.js';
import { MemoryEffectStore, SqliteEffectStore } from '../effects/effect-store.js';
import { MemoryBehaviorStore, SqliteBehaviorStore } from '../memory/behavior-store.js';
import type { FailureLedgerStore } from '../memory/failure-ledger.js';
import { SqliteFailureLedger } from '../memory/failure-ledger.js';
import type { GoalStore } from '../memory/goal-store.js';
import { SqliteGoalStore } from '../memory/goal-store.js';
import { MemoryManager } from '../memory/memory.js';
import { SqliteMemoryStore } from '../memory/store.js';
import { BehaviorRecorder } from '../observability/behavior-recorder.js';
import { maziPaths } from '../paths.js';
import {
    MemoryPromptPackStore,
    PromptPackRegistry,
    SqlitePromptPackStore,
} from '../prompts/index.js';
import { QuestionService } from '../question/service.js';
import { LazySlot } from './lazy.js';

/**
 * P3 资源槽集合：SQLite 句柄与文件型服务一律延迟打开。
 *
 * 只建槽不 open，因此构造阶段零句柄；`views` 是交给 ctx 的稳定代理。
 * 打开时机由真实入口决定（建会话、工具执行、查询账本），关闭按逆序且幂等。
 */
export class RuntimeResources {
    readonly goalStore: LazySlot<GoalStore>;
    readonly memoryManager: LazySlot<MemoryManager>;
    readonly effectStore: LazySlot<EffectStore>;
    readonly blackboard: LazySlot<ProjectBlackboardService>;
    readonly behaviorRecorder: LazySlot<BehaviorRecorder>;
    readonly questionService: LazySlot<QuestionService>;
    readonly failureLedger: LazySlot<FailureLedgerStore>;
    readonly promptPacks: LazySlot<PromptPackRegistry>;

    /** 交给 ctx 的代理视图（构造阶段零 IO）。 */
    readonly views: {
        readonly goalStore: GoalStore;
        readonly memoryManager: MemoryManager;
        readonly effectStore: EffectStore;
        readonly blackboard: ProjectBlackboardService;
        readonly behaviorRecorder: BehaviorRecorder;
        readonly questionService: QuestionService;
        readonly failureLedger: FailureLedgerStore;
        readonly promptPacks: PromptPackRegistry;
    };

    private readonly extra: LazySlot<object>[] = [];

    constructor(readonly config: RuntimeConfig) {
        this.goalStore = new LazySlot(() => new SqliteGoalStore(config.dbPath ?? ':memory:'));
        this.memoryManager = new LazySlot(
            () =>
                new MemoryManager(
                    config.dbPath !== undefined
                        ? { store: new SqliteMemoryStore(config.dbPath) }
                        : {},
                ),
        );
        this.effectStore = new LazySlot(() =>
            config.dbPath !== undefined
                ? new SqliteEffectStore(config.dbPath)
                : new MemoryEffectStore(),
        );
        this.blackboard = new LazySlot(() =>
            config.dbPath !== undefined
                ? new ProjectBlackboardService(new SqliteBlackboardStore(config.dbPath))
                : new ProjectBlackboardService(new MemoryBlackboardStore()),
        );
        this.behaviorRecorder = new LazySlot(() => {
            const recorder = new BehaviorRecorder(
                config.dbPath !== undefined
                    ? new SqliteBehaviorStore(config.dbPath)
                    : new MemoryBehaviorStore(),
            );
            // 迁移只在行为库首次打开时跑一次（single-flight 由 recorder 保证）。
            if (config.behaviorDir !== undefined && config.dbPath !== undefined) {
                void recorder.migrateFromJsonl(config.behaviorDir).catch((error: unknown) => {
                    process.stderr.write(`behavior migration error: ${String(error)}\n`);
                });
            }
            return recorder;
        });
        this.questionService = new LazySlot(
            () =>
                new QuestionService({
                    ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
                    taxonomyFile: config.questionTaxonomyFile ?? maziPaths().questionTaxonomyFile,
                }),
        );
        this.failureLedger = new LazySlot(
            () => new SqliteFailureLedger(config.dbPath ?? ':memory:'),
        );
        this.promptPacks = new LazySlot(
            () =>
                new PromptPackRegistry(
                    undefined,
                    config.dbPath !== undefined
                        ? new SqlitePromptPackStore(config.dbPath)
                        : new MemoryPromptPackStore(),
                ),
        );
        this.views = {
            goalStore: this.goalStore.view(),
            memoryManager: this.memoryManager.view(),
            effectStore: this.effectStore.view(),
            blackboard: this.blackboard.view(),
            behaviorRecorder: this.behaviorRecorder.view(),
            questionService: this.questionService.view(),
            failureLedger: this.failureLedger.view(),
            promptPacks: this.promptPacks.view(),
        };
    }

    /** 追加自定义资源槽（仍需延迟打开；用于按依赖闭包构造的栈）。 */
    addSlot<T extends object>(open: () => T): LazySlot<T> {
        const slot = new LazySlot(open);
        this.extra.push(slot);
        return slot;
    }

    /** 已打开的槽数量（验收与测试用）。 */
    openCount(): number {
        return this.slots().filter((slot) => slot.isOpen()).length;
    }

    /** 逆序释放已打开的资源；未打开的槽不产生副作用。幂等。 */
    close(): void {
        for (const slot of this.slots().reverse()) slot.closeIfOpen();
    }

    private slots(): LazySlot<object>[] {
        return [
            ...this.extra,
            this.goalStore,
            this.memoryManager,
            this.effectStore,
            this.blackboard,
            this.behaviorRecorder,
            this.questionService,
            this.failureLedger,
            this.promptPacks,
        ];
    }
}
