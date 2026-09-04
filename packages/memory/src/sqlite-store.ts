import { DatabaseSync } from 'node:sqlite';
import type {
    FlagSnapshot,
    MemoryStore,
    Session,
    Step,
    Turn,
    TurnCheckpoint,
    UserInteractionRecord,
} from '@mazi/core';
import { createSchema } from './schema.js';

/** SQL 绑定值窄子集（node:sqlite 支持 null/number/bigint/string/ArrayBufferView） */
type SqlParam = string | number | null;

/** 读出行（node:sqlite 的 get/all 返回 Record；列值类型自行收窄） */
type SqlRow = Record<string, unknown>;

/** 对象图 → JSON 文本；undefined 落为 NULL（对应可选列） */
function toJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}

/** JSON 文本 → 对象；NULL/缺失 → undefined */
function fromJson<T>(raw: unknown): T | undefined {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : undefined;
}

/** 可空整数列收窄 */
function asNumber(raw: unknown): number | undefined {
    return typeof raw === 'number' ? raw : undefined;
}

/** 可空文本列收窄 */
function asString(raw: unknown): string | undefined {
    return typeof raw === 'string' ? raw : undefined;
}

/** FlagSnapshot 仅落 values+trace；方法为运行时行为，读取时按 core 语义重建 */
function serializeFlagSnapshot(snapshot: FlagSnapshot): string {
    return JSON.stringify({ values: snapshot.values, trace: snapshot.trace });
}

/** 从 flag_snapshot_json 重建可调用的 FlagSnapshot（语义与冻结快照一致） */
function hydrateFlagSnapshot(raw: unknown): FlagSnapshot {
    const stored = fromJson<{ values: Record<string, unknown>; trace: FlagSnapshot['trace'] }>(raw);
    if (stored === undefined) {
        return {
            values: {},
            trace: [],
            isEnabled: () => false,
            getNumber: () => undefined,
            getString: () => undefined,
        };
    }
    const values = stored.values;
    return {
        values,
        trace: stored.trace,
        isEnabled(key: string): boolean {
            return values[key] === true;
        },
        getNumber(key: string): number | undefined {
            return typeof values[key] === 'number' ? (values[key] as number) : undefined;
        },
        getString(key: string): string | undefined {
            return typeof values[key] === 'string' ? (values[key] as string) : undefined;
        },
    };
}

/** sessions 行 → Session 主体（turns 由调用方从子表水合后填充） */
function sessionFromRow(row: SqlRow): Session {
    const userId = asString(row.user_id);
    const endedAt = asNumber(row.ended_at);
    const outcome = asString(row.outcome);
    const aggregate = fromJson<Session['aggregate']>(row.aggregate_json);
    const session: Session = {
        sessionId: row.session_id as string,
        rawIntent: row.raw_intent as string,
        goal: fromJson<Session['goal']>(row.goal_json) as Session['goal'],
        strategyId: row.strategy_id as string,
        state: row.state as Session['state'],
        turns: [],
        flagSnapshot: hydrateFlagSnapshot(row.flag_snapshot_json),
        createdAt: row.created_at as number,
    };
    if (userId !== undefined) {
        session.userId = userId;
    }
    if (endedAt !== undefined) {
        session.endedAt = endedAt;
    }
    if (outcome !== undefined) {
        session.outcome = outcome as Session['outcome'];
    }
    if (aggregate !== undefined) {
        session.aggregate = aggregate;
    }
    return session;
}

/** turns 行 → Turn（stepIds 先取落库快照，loadSession 阶段再以 steps 表回填） */
function turnFromRow(row: SqlRow): Turn {
    const capacity = fromJson<Turn['capacity']>(row.capacity_json);
    const checkpoint = fromJson<Turn['checkpoint']>(row.checkpoint_json);
    const turn: Turn = {
        turnId: row.turn_id as string,
        sessionId: row.session_id as string,
        contract: fromJson<Turn['contract']>(row.contract_json) as Turn['contract'],
        stepIds: fromJson<string[]>(row.step_ids_json) ?? [],
        status: row.status as Turn['status'],
        attempt: row.attempt as number,
    };
    if (capacity !== undefined) {
        turn.capacity = capacity;
    }
    if (checkpoint !== undefined) {
        turn.checkpoint = checkpoint;
    }
    return turn;
}

/** steps 行 → Step（可选列缺省时不携带，保持与原对象一致） */
function stepFromRow(row: SqlRow): Step {
    const model = fromJson<Step['model']>(row.model_json);
    const usage = fromJson<Step['usage']>(row.usage_json);
    const error = fromJson<Step['error']>(row.error_json);
    const endedAt = asNumber(row.ended_at);
    const decisionContext = fromJson<Step['decisionContext']>(row.decision_context_json);
    const step: Step = {
        stepId: row.step_id as string,
        turnId: row.turn_id as string,
        sessionId: row.session_id as string,
        seq: row.seq as number,
        kind: row.kind as Step['kind'],
        payload: fromJson<Step['payload']>(row.payload_json) as Step['payload'],
        status: row.status as Step['status'],
        startedAt: row.started_at as number,
    };
    if (model !== undefined) {
        step.model = model;
    }
    if (usage !== undefined) {
        step.usage = usage;
    }
    if (error !== undefined) {
        step.error = error;
    }
    if (endedAt !== undefined) {
        step.endedAt = endedAt;
    }
    if (decisionContext !== undefined) {
        step.decisionContext = decisionContext;
    }
    return step;
}

/** user_interactions 行 → UserInteractionRecord（core 的 intent 字段不在表结构中，不持久化） */
function recordFromRow(row: SqlRow): UserInteractionRecord {
    const userId = asString(row.user_id);
    const outcome = fromJson<UserInteractionRecord['outcome']>(row.outcome_json);
    const record: UserInteractionRecord = {
        recordId: row.record_id as string,
        sessionId: row.session_id as string,
        rawInput: row.raw_input as string,
        inputTimestamp: row.input_timestamp as number,
        thoughtTrace: fromJson<UserInteractionRecord['thoughtTrace']>(row.thought_trace_json) ?? [],
        actionTrace: fromJson<UserInteractionRecord['actionTrace']>(row.action_trace_json) ?? [],
        feedback: fromJson<UserInteractionRecord['feedback']>(row.feedback_json) ?? [],
        metrics:
            fromJson<UserInteractionRecord['metrics']>(row.metrics_json) ??
            ({} as UserInteractionRecord['metrics']),
        tags: fromJson<string[]>(row.tags_json) ?? [],
        status: row.status as UserInteractionRecord['status'],
        updatedAt: row.updated_at as number,
    };
    if (userId !== undefined) {
        record.userId = userId;
    }
    if (outcome !== undefined) {
        record.outcome = outcome;
    }
    return record;
}

/**
 * core MemoryStore 的 node:sqlite 落地实现（MVP v1.0 §8 F8 / D1）。
 * 表结构见 ./schema；对象图 JSON 列序列化；turn/step/checkpoint 支持断点续传所需读写。
 */
export class SqliteMemoryStore implements MemoryStore {
    private readonly db: DatabaseSync;
    private closed = false;

    /**
     * @param dbPath SQLite 文件路径；':memory:' 或缺省均打开内存库。
     */
    constructor(dbPath: string = ':memory:') {
        this.db = new DatabaseSync(dbPath);
        createSchema(this.db);
    }

    /** 关闭底层连接（幂等：重复调用安全） */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.db.close();
    }

    /** 整 Session 落库：sessions 行 UPSERT + 级联保存携带的 Turn（Steps 由 saveStep 单独落盘） */
    async saveSession(session: Session): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO sessions
                    (session_id, user_id, raw_intent, goal_json, strategy_id, state,
                     flag_snapshot_json, turn_ids_json, aggregate_json, created_at,
                     ended_at, outcome)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        user_id = excluded.user_id,
                        raw_intent = excluded.raw_intent,
                        goal_json = excluded.goal_json,
                        strategy_id = excluded.strategy_id,
                        state = excluded.state,
                        flag_snapshot_json = excluded.flag_snapshot_json,
                        turn_ids_json = excluded.turn_ids_json,
                        aggregate_json = excluded.aggregate_json,
                        created_at = excluded.created_at,
                        ended_at = excluded.ended_at,
                        outcome = excluded.outcome`,
            )
            .run(
                session.sessionId,
                session.userId ?? null,
                session.rawIntent,
                JSON.stringify(session.goal),
                session.strategyId,
                session.state,
                serializeFlagSnapshot(session.flagSnapshot),
                JSON.stringify(session.turns.map((turn) => turn.turnId)),
                toJson(session.aggregate),
                session.createdAt,
                session.endedAt ?? null,
                session.outcome ?? null,
            );
        for (const turn of session.turns) {
            await this.saveTurn(turn);
        }
    }

    /** 读 Session：sessions 行 + listTurns 水合；turn.stepIds 以 steps 表为准回填（按 seq） */
    async loadSession(sessionId: string): Promise<Session | undefined> {
        const row = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
        if (row === undefined) {
            return undefined;
        }
        const base = sessionFromRow(row);
        const turns = await this.listTurns(sessionId);
        const hydratedTurns = await Promise.all(
            turns.map(async (turn) => {
                const steps = await this.listSteps(turn.turnId);
                return { ...turn, stepIds: steps.map((step) => step.stepId) };
            }),
        );
        return { ...base, turns: hydratedTurns };
    }

    /** Turn UPSERT（按 turn_id 覆盖，同 Key 可重复保存） */
    async saveTurn(turn: Turn): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO turns
                    (turn_id, session_id, contract_json, capacity_json, step_ids_json,
                     status, attempt, checkpoint_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(turn_id) DO UPDATE SET
                        session_id = excluded.session_id,
                        contract_json = excluded.contract_json,
                        capacity_json = excluded.capacity_json,
                        step_ids_json = excluded.step_ids_json,
                        status = excluded.status,
                        attempt = excluded.attempt,
                        checkpoint_json = excluded.checkpoint_json`,
            )
            .run(
                turn.turnId,
                turn.sessionId,
                JSON.stringify(turn.contract),
                toJson(turn.capacity),
                JSON.stringify(turn.stepIds),
                turn.status,
                turn.attempt,
                toJson(turn.checkpoint),
            );
    }

    /** 会话内 Turn 列表（按创建顺序） */
    async listTurns(sessionId: string): Promise<Turn[]> {
        const rows = this.db
            .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY rowid ASC')
            .all(sessionId);
        return rows.map((row) => turnFromRow(row));
    }

    /** Step UPSERT（step_id 为 PK；同一 stepId 重复保存幂等覆盖，唯一性以 stepId 为准） */
    async saveStep(step: Step): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO steps
                    (step_id, turn_id, session_id, seq, kind, payload_json, model_json,
                     usage_json, status, error_json, decision_context_json, started_at,
                     ended_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(step_id) DO UPDATE SET
                        turn_id = excluded.turn_id,
                        session_id = excluded.session_id,
                        seq = excluded.seq,
                        kind = excluded.kind,
                        payload_json = excluded.payload_json,
                        model_json = excluded.model_json,
                        usage_json = excluded.usage_json,
                        status = excluded.status,
                        error_json = excluded.error_json,
                        decision_context_json = excluded.decision_context_json,
                        started_at = excluded.started_at,
                        ended_at = excluded.ended_at`,
            )
            .run(
                step.stepId,
                step.turnId,
                step.sessionId,
                step.seq,
                step.kind,
                JSON.stringify(step.payload),
                toJson(step.model),
                toJson(step.usage),
                step.status,
                toJson(step.error),
                toJson(step.decisionContext),
                step.startedAt,
                step.endedAt ?? null,
            );
    }

    /** Turn 内 Step 列表（按 seq 升序；seq 相同按写入顺序稳定） */
    async listSteps(turnId: string): Promise<Step[]> {
        const rows = this.db
            .prepare('SELECT * FROM steps WHERE turn_id = ? ORDER BY seq ASC, rowid ASC')
            .all(turnId);
        return rows.map((row) => stepFromRow(row));
    }

    /** 断点续传：把 checkpoint 写回对应 Turn 的 checkpoint_json（要求该 Turn 已落库） */
    async saveCheckpoint(turnId: string, checkpoint: TurnCheckpoint): Promise<void> {
        this.db
            .prepare('UPDATE turns SET checkpoint_json = ? WHERE turn_id = ?')
            .run(JSON.stringify(checkpoint), turnId);
    }

    /** 读取断点；Turn 不存在或未写过断点时返回 undefined */
    async loadCheckpoint(turnId: string): Promise<TurnCheckpoint | undefined> {
        const row = this.db
            .prepare('SELECT checkpoint_json FROM turns WHERE turn_id = ?')
            .get(turnId);
        if (row === undefined) {
            return undefined;
        }
        return fromJson<TurnCheckpoint>(row.checkpoint_json);
    }

    /** 用户交互记录 UPSERT（按 record_id 覆盖，随事件流持续更新） */
    async saveUserInteractionRecord(record: UserInteractionRecord): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO user_interactions
                    (record_id, session_id, user_id, raw_input, input_timestamp,
                     thought_trace_json, action_trace_json, feedback_json, outcome_json,
                     metrics_json, tags_json, status, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(record_id) DO UPDATE SET
                        session_id = excluded.session_id,
                        user_id = excluded.user_id,
                        raw_input = excluded.raw_input,
                        input_timestamp = excluded.input_timestamp,
                        thought_trace_json = excluded.thought_trace_json,
                        action_trace_json = excluded.action_trace_json,
                        feedback_json = excluded.feedback_json,
                        outcome_json = excluded.outcome_json,
                        metrics_json = excluded.metrics_json,
                        tags_json = excluded.tags_json,
                        status = excluded.status,
                        updated_at = excluded.updated_at`,
            )
            .run(
                record.recordId,
                record.sessionId,
                record.userId ?? null,
                record.rawInput,
                record.inputTimestamp,
                JSON.stringify(record.thoughtTrace),
                JSON.stringify(record.actionTrace),
                JSON.stringify(record.feedback),
                toJson(record.outcome),
                JSON.stringify(record.metrics),
                JSON.stringify(record.tags ?? []),
                record.status,
                record.updatedAt,
            );
    }

    /** 按 record_id 读取用户交互记录 */
    async loadUserInteractionRecord(recordId: string): Promise<UserInteractionRecord | undefined> {
        const row = this.db
            .prepare('SELECT * FROM user_interactions WHERE record_id = ?')
            .get(recordId);
        return row === undefined ? undefined : recordFromRow(row);
    }

    /** 某 Session 最新（按 updated_at DESC）的一条用户交互记录 */
    async loadUserInteractionBySession(
        sessionId: string,
    ): Promise<UserInteractionRecord | undefined> {
        const row = this.db
            .prepare(
                'SELECT * FROM user_interactions WHERE session_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
            )
            .get(sessionId);
        return row === undefined ? undefined : recordFromRow(row);
    }

    /** 用户交互记录列表：按 updated_at DESC；支持 userId/status 过滤与 limit 截断 */
    async listUserInteractionRecords(opts?: {
        userId?: string;
        status?: 'recording' | 'completed';
        limit?: number;
    }): Promise<UserInteractionRecord[]> {
        const where: string[] = [];
        const params: SqlParam[] = [];
        if (opts?.userId !== undefined) {
            where.push('user_id = ?');
            params.push(opts.userId);
        }
        if (opts?.status !== undefined) {
            where.push('status = ?');
            params.push(opts.status);
        }
        let sql = 'SELECT * FROM user_interactions';
        if (where.length > 0) {
            sql += ` WHERE ${where.join(' AND ')}`;
        }
        sql += ' ORDER BY updated_at DESC, rowid DESC';
        const limit = opts?.limit;
        if (typeof limit === 'number' && limit > 0) {
            sql += ' LIMIT ?';
            params.push(Math.floor(limit));
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((row) => recordFromRow(row));
    }
}
