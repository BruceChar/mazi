# 事件存储 SQLite 化设计（R5）

## 1. 背景与问题

当前事件权威存储为 `~/.mazi/events/<rootGoalId>.jsonl` 平文件（append-only）。
实测：主目录 196 文件、454MB、63.6 万行；`replayAll()` 每次请求全量读盘 + 逐行
`JSON.parse` 约 4.3s，而权限审计只关心 2321 条。平文件无索引，全局视图无法按
类型/时间/根目标裁剪读取，前端分页也省不掉扫描。

## 2. 目标

- 新事件写入 **SQLite 权威库**，替代 JSONL 成为新事件的落盘介质。
- 审计全局查询走 SQL 索引，不再全量扫描；单次查询降到毫秒级。
- 保留 `seq / prevHash / hash` 链式防篡改校验。
- **历史 454MB JSONL 不迁移**：旧文件只读保留，新事件入 SQLite；回放合并两个来源。

非目标：不重写链式哈希算法；不做 JSONL → SQLite 的历史批量导入；不改事件载荷结构。

## 3. 表结构（独立 `events.db`，避免与 mazi.db 写锁竞争）

```sql
CREATE TABLE IF NOT EXISTS events (
    root_goal_id TEXT NOT NULL,
    seq          INTEGER,
    event_id     TEXT NOT NULL,
    type         TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,
    actor        TEXT,
    session_id   TEXT,
    prev_hash    TEXT,
    hash         TEXT,
    event_json   TEXT NOT NULL,
    PRIMARY KEY (root_goal_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_root    ON events(root_goal_id, seq);
```

- `event_json` 存事件原始 envelope（原样反序列化为 `HarnessEvent`），不拆 payload/attributes。
- 查询列（type/timestamp/root_goal_id/seq）冗余抽出建索引。
- `seq` 可空（legacy 无链事件）；主键 `(root_goal_id, seq)` 对空 seq 需用 event_id 兜底，
  实际插入以 `event_id` 为唯一去重键，seq 仅作链序号。

## 3.1 持久化过滤与裁剪（容量治理，先于入库）

454MB 实测构成：`llm.stream_event` 62.2 万行 / 345MB（97.7% 行，逐 token 碎片），
`step.started/ended` 1.03 万行 / 103MB（单行 ~12KB，重复全文 content），真正权限事件
仅 ~2200 条 / <2.5MB。过滤与裁剪只作用于**持久化层**，不影响内存订阅与 SSE/UI 实时流。

- **不落盘**：`llm.stream_event`。它是 provider 逐 token 流式回调碎片，审计/复盘不需要；
  实际最终内容由 `step.ended` 承载落盘。内存分发照常（实时 UI 渲染仍可收到碎片）。
- **`step.started` 只存元数据**：首见通知，实际内容与 `step.ended` 重复，落盘时丢弃
  content/thinking/answer/output/result，保留 kind/status/goalId/taskId/stepId/nodeId/usage。
- **`step.ended` 保留实际内容 + 元数据**：最终回复/工具结果原样保留，单个超长文本字段
  截断到 4000 字封顶（避免同一 step 反复存 12KB 全文），元数据（kind/status/ID/usage/error）
  全部保留。
- 其余事件（policy.* / approval.* / goal.* / tool.* 等）原样落盘。

该规则由独立纯函数实现（测试先行），持久化层（入库 / 退役前的 JSONL）共用，emit 源头不改。

## 4. 存储接口（runtime 内部，测试先行）

```ts
interface EventStore {
    append(event: HarnessEvent): void;
    replay(rootGoalId: string): HarnessEvent[];
    /** 新库内全局扫描（按时间升序）；旧 JSONL 由兼容层合并。 */
    replayAll(): HarnessEvent[];
    /** 按类型 + 时间范围裁剪（审计专用，替代全量扫描）。 */
    query(filter: { types?: string[]; from?: number; to?: number; rootGoalId?: string }): HarnessEvent[];
    chainHead(rootGoalId: string): { seq: number; hash: string };
    close(): void;
}
```

## 5. 回放合并策略（新库 + 旧文件只读）

- `replay(rootGoalId)`：先读 SQLite，再追加该根的旧 JSONL 文件中未入库事件（按 ts 去重，
  以 event_id 为准）；单根场景旧文件读取量小，可接受。
- `replayAll()`：默认只查 SQLite（新事件快）；旧 JSONL 仅在显式要求历史时由兼容层读取，
  避免再次全量扫 454MB。
- 权限审计端点：优先 `query({types, from, to})` 走索引；旧数据缺口在文档中标注。

## 6. 链式校验

`verifyChain` 逻辑不变：逐行核对 `seq` 连续、`prevHash` 衔接、`hash` 重算；数据源换成
SQLite 结果集（已按 root_goal_id, seq 排序）。

## 7. 分阶段落地

1. `SqliteEventStore` 存储类：建表 / append / query / replay / chainHead，纯函数与落盘测试先行。
2. DefaultEventBus 注入存储：emit 写库替换 appendFileSync；subscribe/内存分发不变。
3. 旧 JSONL 只读兼容层（replay 单根合并）。
4. 审计端点改走 `query` 索引；基准测试固化旧全量耗时与新查询耗时。
5. 文档与 README 更新；旧文件保留只读、不删除。

## 8. 验收测试要点

- append 后 query 按类型/时间范围精确命中，不全表扫。
- replay(rootGoalId) 顺序与链式 head 正确。
- 去重：同一 event_id 重复 append 不产生两行。
- verifyChain 对入库事件 ok=true，篡改 seq/hash 返回 AUDIT_TAMPER_SUSPECTED。
- 审计端点返回记录数与旧全量口径一致（新事件部分）。
