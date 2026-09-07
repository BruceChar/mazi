import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
    EventBus,
    EventFilter,
    EventSink,
    HarnessEvent,
    HarnessEventType,
    Unsubscribe,
} from '@mazi/core';
import { ulid } from '@mazi/core';

/**
 * Turn 级事件：必须携带 turnId。
 * 说明：plan.created / plan.invalid 发生在 Turn 创建之前（属 Session 级），不在本集合内。
 * llm.* 事件在模型调用（Step 创建前）发出，归为 Turn 级。
 */
const TURN_SCOPED: ReadonlySet<HarnessEventType> = new Set<HarnessEventType>([
    'turn.started',
    'turn.ended',
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
    'rollback.executed',
]);

/** Step 级事件：必须携带 turnId 与 stepId */
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
    if (typeof event.sessionId !== 'string' || event.sessionId.length === 0) {
        throw new Error(`event 缺少必填 sessionId（type=${event.type}）`);
    }
    if (TURN_SCOPED.has(event.type) && typeof event.turnId !== 'string') {
        throw new Error(`事件 ${event.type} 缺少必填 turnId`);
    }
    if (STEP_SCOPED.has(event.type) && typeof event.stepId !== 'string') {
        throw new Error(`事件 ${event.type} 缺少必填 stepId`);
    }
}

/** 事件构造助手：补齐 eventId(ULID) 与 timestamp */
export interface NewEventInput {
    type: HarnessEvent['type'];
    sessionId: string;
    turnId?: string;
    stepId?: string;
    attributes?: HarnessEvent['attributes'];
    payload?: unknown;
}

export function newHarnessEvent(input: NewEventInput): HarnessEvent {
    return {
        type: input.type,
        sessionId: input.sessionId,
        turnId: input.turnId,
        stepId: input.stepId,
        attributes: input.attributes ?? {},
        payload: input.payload,
        eventId: ulid(),
        timestamp: Date.now(),
    };
}

export interface EventBusOptions {
    /** JSONL 落盘目录；默认取 EVENT_LOG_DIR 环境变量，否则 ./events */
    eventDir?: string;
    /** 事件写入失败时的错误回调（默认写 stderr） */
    onWriteError?: (error: unknown, event: HarnessEvent) => void;
}

/**
 * 默认事件总线（MVP）：
 * - emit 永不被 Flag 阻断（Flag 只控制上层是否订阅额外 sink）；
 * - 每条事件同步派发给匹配订阅者，并异步串行落盘 JSONL（按 sessionId 分文件）；
 * - replay(sessionId) 从磁盘只读回放该会话全部事件。
 */
export class DefaultEventBus implements EventBus {
    private readonly dir: string;
    private readonly subscribers = new Set<{ filter: EventFilter; sink: EventSink }>();
    private writeChain: Promise<void> = Promise.resolve();
    private readonly onWriteError: (error: unknown, event: HarnessEvent) => void;

    constructor(opts: EventBusOptions = {}) {
        this.dir = opts.eventDir ?? defaultEventDir();
        this.onWriteError =
            opts.onWriteError ??
            ((error: unknown) => process.stderr.write(`event persist error: ${String(error)}\n`));
    }

    get eventDir(): string {
        return this.dir;
    }

    emit(event: HarnessEvent): void {
        validateTraceIds(event);
        const resolved: HarnessEvent = {
            ...event,
            eventId: event.eventId ?? ulid(),
            timestamp: event.timestamp ?? Date.now(),
        };
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

    replay(sessionId: string): HarnessEvent[] {
        let raw: string;
        try {
            raw = readFileSync(this.filePath(sessionId), 'utf8');
        } catch {
            return [];
        }
        const events: HarnessEvent[] = [];
        for (const line of raw.split('\n')) {
            if (line.trim().length === 0) {
                continue;
            }
            try {
                const parsed = JSON.parse(line) as HarnessEvent;
                if (parsed.sessionId === sessionId) {
                    events.push(parsed);
                }
            } catch {
                // 跳过损坏行（审计完整性由持久化保证，重放尽力而为）
            }
        }
        return events;
    }

    /** 等待所有已排队事件写盘完成（测试与优雅停机用） */
    flush(): Promise<void> {
        return this.writeChain;
    }

    private filePath(sessionId: string): string {
        return join(this.dir, `${sessionId}.jsonl`);
    }

    private enqueuePersist(event: HarnessEvent): void {
        this.writeChain = this.writeChain.then(() => {
            try {
                mkdirSync(this.dir, { recursive: true });
                appendFileSync(
                    this.filePath(event.sessionId),
                    `${JSON.stringify(event)}\n`,
                    'utf8',
                );
            } catch (error) {
                this.onWriteError(error, event);
            }
        });
    }
}

/** 控制台 sink：由上层在 Flag console.sink=true 时订阅；不影响文件落盘 */
export class ConsoleSink implements EventSink {
    readonly id = 'console';

    handle(event: HarnessEvent): void {
        const ids = [event.sessionId, event.turnId, event.stepId].filter(Boolean).join('/');
        process.stdout.write(`[event] ${event.type} ${ids}\n`);
    }
}
