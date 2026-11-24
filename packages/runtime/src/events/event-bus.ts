import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
    EventBus,
    EventFilter,
    EventSink,
    HarnessEvent,
    HarnessEventType,
    Unsubscribe,
} from '@mazi/core';
import { authz, ulid } from '@mazi/core';
import { defaultEventDbPath } from '../paths.js';
import { shouldPersist, slimForStore } from './persist-policy.js';
import { SqliteEventStore } from './sqlite-event-store.js';

/**
 * Task 级事件：必须携带 taskId。
 * 说明：plan.created / plan.invalid 发生在 Task 创建之前（属 goal 级），不在本集合内。
 * llm.* 事件在模型调用（Step 创建前）发出，归为 Task 级。
 */
const TASK_SCOPED: ReadonlySet<HarnessEventType> = new Set<HarnessEventType>([
    'task.started',
    'task.ended',
    'llm.request',
    'llm.stream_event',
    'llm.response',
    'capacity.assembled',
    'capacity.degraded',
    'provider.selected',
    'provider.fallback',
    'budget.reallocation',
    'budget.exceeded',
    'reflection.verdict',
    'verification.completed',
    'rollback.executed',
]);

/** Step 级事件：必须携带 taskId 与 stepId */
const STEP_SCOPED: ReadonlySet<HarnessEventType> = new Set<HarnessEventType>([
    'step.started',
    'step.ended',
    'tool.invoke',
    'tool.result',
    'tool.blocked',
    'context.strategy.applied',
]);

const LEVEL_ORDER: Record<string, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const EVENT_LOG_DIR_ENV = 'EVENT_LOG_DIR';
const DEFAULT_EVENT_DIR = './events';

function levelRank(level: string | undefined): number | undefined {
    return level === undefined ? undefined : LEVEL_ORDER[level];
}

function defaultEventDir(): string {
    return process.env[EVENT_LOG_DIR_ENV] ?? DEFAULT_EVENT_DIR;
}

/** 过滤语义（MVP）：仅支持按事件类型过滤；minLevel/requireFlag 设置即抛错（fail-fast） */
function assertSupportedFilter(filter: EventFilter): void {
    if (filter.minLevel !== undefined || filter.requireFlag !== undefined) {
        throw new Error(
            'EventFilter.minLevel / requireFlag 在 MVP 版 EventBus 不支持（仅支持 types 过滤）' +
                '；若要使用请先扩展 observability 契约',
        );
    }
}

function matchesFilter(event: HarnessEvent, filter: EventFilter): boolean {
    if (filter.types && !filter.types.includes(event.type)) {
        return false;
    }
    if (filter.minLevel !== undefined) {
        const minRank = levelRank(filter.minLevel);
        const rank = levelRank(event.attributes?.['harness.level'] as string | undefined);
        if (minRank === undefined || rank === undefined || rank < minRank) {
            return false;
        }
    }
    if (filter.requireFlag !== undefined) {
        const flags = event.attributes?.['harness.flag_overrides'] as
            | Record<string, unknown>
            | undefined;
        const value = flags?.[filter.requireFlag.key];
        if (
            value === undefined ||
            (filter.requireFlag.equals !== undefined && value !== filter.requireFlag.equals)
        ) {
            return false;
        }
    }
    return true;
}

function validateTraceIds(event: HarnessEvent): void {
    if (typeof event.rootGoalId !== 'string' || event.rootGoalId.length === 0) {
        throw new Error(`event 缺少必填 rootGoalId（type=${event.type}）`);
    }
    if (TASK_SCOPED.has(event.type) && typeof event.taskId !== 'string') {
        throw new Error(`事件 ${event.type} 缺少必填 taskId`);
    }
    if (STEP_SCOPED.has(event.type) && typeof event.stepId !== 'string') {
        throw new Error(`事件 ${event.type} 缺少必填 stepId`);
    }
}

/** 事件构造助手：补齐 eventId(ULID) 与 timestamp */
export interface NewEventInput {
    type: HarnessEvent['type'];
    rootGoalId: string;
    /** Owning conversation (session); omitted for non-conversation runs. */
    sessionId?: string;
    goalId?: string;
    taskId?: string;
    stepId?: string;
    attributes?: HarnessEvent['attributes'];
    payload?: unknown;
    causedBy?: string;
    actor?: HarnessEvent['actor'];
}

export function newHarnessEvent(input: NewEventInput): HarnessEvent {
    return {
        type: input.type,
        rootGoalId: input.rootGoalId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        goalId: input.goalId,
        taskId: input.taskId,
        stepId: input.stepId,
        attributes: input.attributes ?? {},
        payload: input.payload,
        ...(input.causedBy !== undefined ? { causedBy: input.causedBy } : {}),
        ...(input.actor !== undefined ? { actor: input.actor } : {}),
        eventId: ulid(),
        timestamp: Date.now(),
    };
}

export interface ChainVerification {
    ok: boolean;
    code?: 'AUDIT_TAMPER_SUSPECTED';
    reason?: string;
    verified: number;
    legacy: number;
    head?: string;
}

export interface EventBusOptions {
    /** 旧 JSONL 只读目录（历史兼容，R5d 合并用）；新事件写入 SQLite 权威库 */
    eventDir?: string;
    /** 只读附加目录（如历史/实验事件），R5d 一并收录，不参与写入 */
    extraDirs?: string[];
    /** 事件权威库路径；缺省取 eventDir 旁的 events.db，再缺省 $MAZI_HOME/events.db */
    dbPath?: string;
    /** 可注入已构造的事件库（测试/宿主用）；提供后忽略 dbPath */
    store?: SqliteEventStore;
    /** 事件写入失败时的错误回调（默认写 stderr） */
    onWriteError?: (error: unknown, event: HarnessEvent) => void;
    /**
     * 会话归因解析器：由宿主按 rootGoalId 反查 conversationId。
     * 事件自带的 sessionId 优先，解析结果只在缺失时补齐（不覆盖既有事实）。
     */
    sessionOf?: (rootGoalId: string) => string | undefined;
}

/**
 * 默认事件总线（MVP）：
 * - emit 永不被 Flag 阻断（Flag 只控制上层是否订阅额外 sink）；
 * - 每条事件同步派发给匹配订阅者，并异步串行落盘 JSONL（按 rootGoalId 分文件）；
 * - replay(rootGoalId) 从磁盘只读回放该 root goal 全部事件。
 */
export class DefaultEventBus implements EventBus {
    private readonly dir: string;
    private readonly extraDirs: string[];
    private readonly store: SqliteEventStore;
    private readonly subscribers = new Set<{ filter: EventFilter; sink: EventSink }>();
    private writeChain: Promise<void> = Promise.resolve();
    private readonly onWriteError: (error: unknown, event: HarnessEvent) => void;
    private readonly sessionOf?: (rootGoalId: string) => string | undefined;
    private readonly chainHeads = new Map<string, { seq: number; hash: string }>();

    constructor(opts: EventBusOptions = {}) {
        this.dir = opts.eventDir ?? defaultEventDir();
        this.extraDirs = opts.extraDirs ?? [];
        // 显式 store/dbPath 优先；给了 eventDir（测试/兼容）时库落在该目录旁，否则用 home/events.db。
        const dbPath =
            opts.dbPath ??
            (opts.eventDir !== undefined ? join(this.dir, 'events.db') : defaultEventDbPath());
        this.store = opts.store ?? new SqliteEventStore(dbPath);
        this.sessionOf = opts.sessionOf;
        this.onWriteError =
            opts.onWriteError ??
            ((error: unknown) => process.stderr.write(`event persist error: ${String(error)}\n`));
    }

    get eventDir(): string {
        return this.dir;
    }

    emit(event: HarnessEvent): void {
        validateTraceIds(event);
        const chainHead = this.chainHead(event.rootGoalId);
        const sessionId = event.sessionId ?? this.sessionOf?.(event.rootGoalId);
        const chained: HarnessEvent = {
            ...event,
            ...(sessionId !== undefined ? { sessionId } : {}),
            eventId: event.eventId ?? ulid(),
            timestamp: event.timestamp ?? Date.now(),
            seq: chainHead.seq + 1,
            prevHash: chainHead.hash,
            actor: event.actor ?? 'harness',
        };
        const seq = chained.seq;
        const hash = hashEvent(chained);
        const resolved: HarnessEvent = { ...chained, hash };
        this.chainHeads.set(event.rootGoalId, {
            seq: seq ?? 1,
            hash,
        });
        for (const sub of this.subscribers) {
            if (matchesFilter(resolved, sub.filter)) {
                sub.sink.handle(resolved);
            }
        }
        this.enqueuePersist(resolved);
    }

    subscribe(filter: EventFilter, sink: EventSink): Unsubscribe {
        assertSupportedFilter(filter);
        const entry = { filter, sink };
        this.subscribers.add(entry);
        return () => {
            this.subscribers.delete(entry);
        };
    }

    replay(rootGoalId: string): HarnessEvent[] {
        return this.store.replay(rootGoalId);
    }

    /**
     * 会话回放：从事件库按 sessionId 取全部事件。
     * 同一毫秒内排序确定：会话边界事件恒在最外（started 最前、ended 最后），再按 seq 兜底。
     */
    replaySession(sessionId: string): HarnessEvent[] {
        const events = this.store.query({ sessionId });
        const boundaryRank = (type: string): number => {
            if (type === 'session.started') return -1;
            if (type === 'session.ended') return 1;
            return 0;
        };
        return events.sort(
            (a, b) =>
                a.timestamp - b.timestamp ||
                boundaryRank(a.type) - boundaryRank(b.type) ||
                (a.seq ?? 0) - (b.seq ?? 0),
        );
    }

    /**
     * 全量回放：从事件库按时间升序取全部新事件。
     * 用于跨全部 run 的全局审计；旧 JSONL 历史由 R5d 兼容层按需合并。
     */
    replayAll(): HarnessEvent[] {
        return this.store.query({});
    }

    /** Verify the per-root hash chain without trusting the writer. */
    verifyChain(rootGoalId: string): ChainVerification {
        const events = this.replay(rootGoalId);
        let previous = authz.AUDIT_GENESIS;
        let seq = 0;
        let verified = 0;
        let legacy = 0;
        for (const event of events) {
            if (
                event.seq === undefined ||
                event.prevHash === undefined ||
                event.hash === undefined
            ) {
                legacy += 1;
                continue;
            }
            if (event.seq !== seq + 1) {
                return {
                    ok: false,
                    code: 'AUDIT_TAMPER_SUSPECTED',
                    reason: `seq 断档（期望 ${seq + 1}，实际 ${event.seq}）`,
                    verified,
                    legacy,
                };
            }
            if (event.prevHash !== previous) {
                return {
                    ok: false,
                    code: 'AUDIT_TAMPER_SUSPECTED',
                    reason: `prevHash 断链（seq=${event.seq}）`,
                    verified,
                    legacy,
                };
            }
            const withoutHash = { ...event, hash: undefined };
            if (event.hash !== hashEvent(withoutHash)) {
                return {
                    ok: false,
                    code: 'AUDIT_TAMPER_SUSPECTED',
                    reason: `事件哈希不符（seq=${event.seq}）`,
                    verified,
                    legacy,
                };
            }
            previous = event.hash;
            seq = event.seq;
            verified += 1;
        }
        return {
            ok: true,
            verified,
            legacy,
            ...(verified > 0 ? { head: previous } : {}),
        };
    }

    /** 等待所有已排队事件写盘完成（测试与优雅停机用） */
    flush(): Promise<void> {
        return this.writeChain;
    }

    private chainHead(rootGoalId: string): { seq: number; hash: string } {
        const cached = this.chainHeads.get(rootGoalId);
        if (cached !== undefined) return cached;
        const head = this.store.chainHead(rootGoalId);
        const state = { seq: head.seq, hash: head.hash ?? authz.AUDIT_GENESIS };
        this.chainHeads.set(rootGoalId, state);
        return state;
    }

    private enqueuePersist(event: HarnessEvent): void {
        this.writeChain = this.writeChain.then(() => {
            try {
                if (!shouldPersist(event)) return;
                this.store.append(slimForStore(event));
            } catch (error) {
                this.onWriteError(error, event);
            }
        });
    }
}

function hashEvent(event: HarnessEvent): string {
    const unsigned = JSON.parse(JSON.stringify({ ...event, hash: undefined })) as HarnessEvent;
    return createHash('sha256').update(authz.stableStringify(unsigned)).digest('hex');
}

/** 控制台 sink：由上层在 Flag console.sink=true 时订阅；不影响文件落盘 */
export class ConsoleSink implements EventSink {
    readonly id = 'console';

    handle(event: HarnessEvent): void {
        const ids = [event.rootGoalId, event.goalId, event.taskId, event.stepId]
            .filter(Boolean)
            .join('/');
        process.stdout.write(`[event] ${event.type} ${ids}\n`);
    }
}
