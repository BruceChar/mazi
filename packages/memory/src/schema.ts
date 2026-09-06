/**
 * @mazi/memory 存储 Schema（MVP 设计文档 v1.0 §4.3 D1 / §8 F8）。
 * 五张表：sessions / turns / steps / user_interactions / failure_ledger，对象图以 JSON 列落盘；
 * 由 SqliteMemoryStore 在打开连接后调用，幂等（IF NOT EXISTS），可安全重复执行。
 */

/** 幂等 DDL 集合：五表 + 六索引（覆盖按会话/用户/时序查询的热点路径） */
const DDL_STATEMENTS: string[] = [
    `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        raw_intent TEXT NOT NULL,
        goal_json TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        state TEXT NOT NULL,
        flag_snapshot_json TEXT NOT NULL,
        turn_ids_json TEXT NOT NULL,
        aggregate_json TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        contract_json TEXT NOT NULL,
        capacity_json TEXT,
        step_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        checkpoint_json TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS steps (
        step_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        model_json TEXT,
        usage_json TEXT,
        status TEXT NOT NULL,
        error_json TEXT,
        decision_context_json TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
    );`,
    `CREATE TABLE IF NOT EXISTS user_interactions (
        record_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT,
        raw_input TEXT NOT NULL,
        input_timestamp INTEGER NOT NULL,
        thought_trace_json TEXT NOT NULL,
        action_trace_json TEXT NOT NULL,
        feedback_json TEXT NOT NULL,
        outcome_json TEXT,
        metrics_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS failure_ledger (
        record_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        step_id TEXT,
        failure_kind TEXT NOT NULL,
        cost_usd REAL,
        provider_id TEXT,
        tags_json TEXT NOT NULL,
        summary TEXT,
        created_at INTEGER NOT NULL
    );`,
    'CREATE INDEX IF NOT EXISTS idx_turns_session_id ON turns(session_id);',
    'CREATE INDEX IF NOT EXISTS idx_steps_turn_id_seq ON steps(turn_id, seq);',
    'CREATE INDEX IF NOT EXISTS idx_steps_turn_id ON steps(turn_id);',
    'CREATE INDEX IF NOT EXISTS idx_user_interactions_session_id ON user_interactions(session_id);',
    'CREATE INDEX IF NOT EXISTS idx_user_interactions_user_id ON user_interactions(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_failure_ledger_kind_created_at ON failure_ledger(failure_kind, created_at);',
];

/**
 * 确保四张表与所需索引存在（幂等）。
 * @param db 满足 node:sqlite DatabaseSync 形状的连接（exec/prepare 即足够）。
 */
export function createSchema(db: { exec(sql: string): void; prepare(sql: string): unknown }): void {
    for (const sql of DDL_STATEMENTS) {
        db.exec(sql);
    }
}
