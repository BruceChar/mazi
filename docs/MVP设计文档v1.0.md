# AI Agent Harness MVP 设计文档

> **版本**：v1.0（正式版；替代 `docs/MVP设计文档.md` v0.1 草稿与 `docs/执行计划.md` 中的旧技术选型）
> **依据**：`docs/总体设计文档v1.3.md` §8（后续路线；M1 已完成、M2 起为生产安全与演进范围；v1.2 为历史基线）
> **仓库基线**：monorepo（F1）与 `packages/core` 全部契约（F2）已在提交 `9caf2c9` 及之前完成；本版将 F3 起的实现拆分为独立 Feature。
> **执行约束**：本仓库遵循 `AGENT.md` —— 文档先行、测试先行、严格原子化提交、禁止跨范围修改、禁止无依据优化。
> **现状勘误（2026-09-06）**：v1.1 变更记录中的 ScriptedDriver 已被真实 pi-ai driver 取代；`sessions` 表不再含 `user_id`；Conversation/Session 术语调整见总体设计 v1.3 与会话结构定义。

---

## 变更记录

| 版本 | 变更内容 |
| ---- | -------- |
| v0.1（被替代） | 旧草稿：粗粒度里程碑 M1.1–M1.4；存在若干与仓库现状/可验证性不符的假设（见 §附录A 勘误） |
| **v1.1** | 实施记录：F2.1–F16 全部实现并单 feature 独立提交（Conventional Commits）；118 个测试用例覆盖验收 A1–A15；CLI 演示使用确定性 ScriptedDriver（真实厂商接入留接口） |
| **v1.0** | 重写为可执行契约：固定技术选型（ADR）；如实标注 F1/F2 已完成；F3–F16 按包拆分为独立 Feature，每个 Feature 有明确测试要点、验收标准、依赖与提交建议 |

---

## 1. MVP 目标

以最小工程投入交付一个**可运行、可测试、可恢复、可审计**的 Agent Harness 最小闭环：

1. 接收用户输入 → 创建 Session → 冻结 Flag 快照 → 立即创建用户交互记录（保留原始输入）。
2. 生成 GoalContract（应用层工厂，不调用模型）→ 固定使用 Full-Loop 策略。
3. Planner 线性分解为 TurnContract（默认单 Turn）并执行三条派生校验（工具收窄 / 权限收窄 / 预算守恒）。
4. `assembleCapacity` 完成：能力过滤 + 成本排序的简单路由（读 `turn.contract.tags`）、工具解析、权限收敛、预算切片。
5. Executor 逐 Step 执行（thinking / tool_call / observation），集成 Policy Engine 基础拦截与 Usage 三个采集点。
6. 所有事件经 EventBus emit 并**强制异步落盘 JSONL**（Flag 关闭 ≠ 数据不产生）。
7. 每个 Step 完成后更新 TurnCheckpoint，支持进程崩溃后的断点续传。
8. 用户交互记录随事件流持续更新（thoughtTrace / actionTrace / feedback），Session 结束时写入 outcome 与 metrics。
9. CLI 演示入口 + 端到端集成测试，验证上述全部能力。

**明确不包含**（延后，理由见 §7 风险与限制）：

- 审批门（`approval.gate`）与不可逆操作审批流；不可逆工具一律 `tool.blocked`。
- 独立 Reflector / LLM-as-judge；仅做机械验收判定（对照 `success.conditions`）。
- 六因子路由、分时定价生效、经济画像回写（路由仅 `simple` 模式）。
- 预算加权切片与策略自动升降级（`strategy.auto-escalate` 默认关闭）。
- 复杂上下文策略（summarize / compress / RAG）——采集点 A 仅计数，不执行压缩。
- 用户画像聚合与思维分析（仅做记录与查询）。
- 沙箱进程级隔离（Executor 直接调用工具；仅通过工具白名单与权限收敛控制风险）。
- 真实 LLM 厂商接入（pi-ai 适配）——MVP 通过可插拔 Driver + ScriptedDriver 验证全链路。

---

## 2. 决策记录（ADR，本版锁定，实施时不得偏离）

| # | 决策 | 说明 |
| - | ---- | ---- |
| D1 | 持久化使用 **Node 内置 `node:sqlite`（`DatabaseSync`）** | 运行环境 Node ≥ 24（实测 v24.19.0，`node:sqlite` 可用）；零新增依赖；贴近 v1.2 的 session/turn/step/user_interaction 分表模型。禁止引入 better-sqlite3/sqlite3。 |
| D2 | 事件日志 **JSONL 按 sessionId 分文件**，写入 `$EVENT_LOG_DIR`（默认 `./events`） | 与 v1.2 §6.2 一致；sink 不受业务 Flag 控制。 |
| D3 | LLM 调用经 **`LLMDriver`（core 契约）注入**；MVP 提供确定性 **ScriptedDriver** 作为默认与测试驱动 | 仓库无 pi-ai 依赖、无 API 凭据；真实厂商适配是后续独立 Feature（接口不变，防腐层满足 v1.2 验收 #9）。ScriptedDriver 由场景 JSON 驱动，可模拟 tool_call / usage / 失败，保证全链路可离线验证。 |
| D4 | **零新增运行时依赖**（除 workspace 内包） | core 零依赖；其余包仅依赖 `@mazi/core`（类型）。CLI 参数解析用 `node:util parseArgs`；schema 校验用 policy 包内置的 **mini JSON-Schema 子集校验器**（type/required/properties/enum/minLength/maxLength/pattern 等 MVP 需要项），不引入 TypeBox。 |
| D5 | L1 包之间禁止互相依赖，**事件/存储均以 core 接口注入** | EventBus/MemoryStore/PolicyEngine 接口均已在 core 定义，具体实现分别位于 observability / memory / policy 包，由 harness-runtime 装配。 |
| D6 | 提交采用 **Conventional Commits**：`feat(scope): <msg>`，scope=包名 | 每个 Feature 一个原子提交，禁止混合提交。 |
| D7 | 默认**单 Turn 线性分解**；多 Turn 仅在数据结构与策略循环上保留 | 与 v1.2 §13 M1 界定一致；Planner 结构支持 N 个 Turn，MVP 的 goal 工厂默认产出 1 个。 |
| D8 | Policy 对不可逆工具**一律拒绝**（无审批门） | v1.2 §10 校验点 5 的 MVP 降级：`irreversible=true` 的工具命中即 `tool.blocked`，不提供“降级为只读”的分支（消除旧文档歧义）。 |

---

## 3. 架构与包边界

### 3.1 分层依赖（单向）

```
core (L0, 已完成, 零运行时依赖)
  ↑
observability / flags / usage / policy / memory / provider-llm   (L1, 仅依赖 core)
  ↑
planner / executor / recovery / user-profile                      (L2, 仅依赖 L1+core)
  ↑
strategy-full-loop (L3)  →  harness-runtime (装配)  →  apps/cli (L4)
```

L1 包间互不依赖：EventBus、MemoryStore、PolicyEngine、LLMDriver 等一律以 **core 接口类型 + 构造注入**协作。

### 3.2 各包职责边界（MVP 实现物）

| 包 | 实现物（src 内文件） | 关键行为 / 明确不含 |
| -- | -------------------- | ------------------- |
| `@mazi/core`（已完成） | 契约 14 文件 + index | 见 §4.2 校正项 F2.1 |
| `@mazi/observability` | `event-bus.ts`（含 JSONL FileSink）、`index.ts` | emit 永不被 Flag 阻断；异步队列写盘；`replay(sessionId)`；console sink 由 Flag `console.sink` 控制，只影响控制台打印，不影响落盘。不含 OTel 桥接。 |
| `@mazi/flags` | `evaluator.ts`、`snapshot.ts`、`default-flags.ts`、`index.ts` | 规则按序求值（userIdIn/goalTagIn/turnTagIn/bucketRange）；sessionId 哈希分桶 0–99；快照冻结 + trace；内置默认 Flag 集。不含实验管理 API。 |
| `@mazi/provider-llm` | `driver.ts`（ScriptedDriver 等实现）、`registry.ts`（ProviderPool）、`router.ts`（SimpleRouter）、`index.ts` | SimpleRouter：输入 `turn.tags` 能力过滤（CapabilityTag ∩ provider 能力，health>0.5）→ 按基础单价升序；故障转移按成本升序尝试并回调上报 `provider.selected`/`provider.fallback`。ScriptedDriver 输出场景 JSON 驱动的 `LLMStreamEvent`（含 tool-call/usage 模拟）。不含真实厂商适配、六因子评分、时段定价。 |
| `@mazi/usage` | `tokenizer-registry.ts`、`context-meter.ts`、`cost-calculator.ts`、`aggregate.ts`、`index.ts` | 估算 tokenizer（默认 char/4，预留 vendor 注册）；ContextMeter 生成 `RuntimeContextBreakdown`；CostCalculator 仅按 `pricing.base`（无 tier 生效，`priceTierApplied=base`，记录 `pricingVersion`，与 v1.2 验收 #6 兼容）；AggregateReducer 纯函数累计 Turn/Session 聚合；估算漂移回填（阈值 5%）。不含上下文压缩执行。 |
| `@mazi/policy` | `schema-validator.ts`（mini JSON-Schema 子集）、`policy-engine.ts`、`index.ts` | 同步校验 6 项：白名单 / 权限 / 参数 schema / Goal 级 constraints（内置 network 与 forbidden-resource 两种规则解释，其余 kind 存在即 fail-closed 拒绝）/ 不可逆拦截 / 预算检查。返回 `PolicyVerdict`，事件由调用方（executor）emit。不含审批门。 |
| `@mazi/memory` | `sqlite-store.ts`、`schema.ts`、`index.ts` | 实现 core `MemoryStore`；表 `sessions`/`turns`/`steps`/`user_interactions`；对象图 JSON 列序列化；Checkpoint 读写。不含检索 / 跨 Session 记忆。 |
| `@mazi/planner` | `planner.ts`、`budget.ts`、`tool-resolver.ts`、`index.ts` | 单 Turn 线性分解（goal→1 个 TurnContract，结构支持 N）；三条派生校验（违反 → emit `plan.invalid`）；均分切片 + reserveRatio + `MIN_TURN_BUDGET_USD` 下限；`assembleCapacity`：注入 SimpleRouter 选模型、工具解析（optional 缺失 → `capacity.degraded`）、权限 = min(声明, 工具需求 max, 运行时限)；sandbox 由 `expectedSideEffects` 推导。 |
| `@mazi/executor` | `executor.ts`、`context-builder.ts`、`tool-runner.ts`、`step-loop.ts`、`index.ts` | Turn 内 Step 循环：构建 context（采集点 A）→ driver.stream 消费（采集点 B）→ 计价与漂移回填（采集点 C）→ tool_call 过 Policy → ToolRunner 执行（注入实现，如 `fs.read`）→ 观察回注 → Step 持久化 + Checkpoint 更新 → 终止条件判定。直接调用工具，不做沙箱进程隔离。 |
| `@mazi/recovery` | `checkpoint.ts`、`resumer.ts`、`index.ts` | CheckpointManager（save/load）；resumeTurn：从 memory 加载 Turn + 已完成 Step，重建上下文，从断点继续。不含事件流回放引擎（回放能力在 observability）。 |
| `@mazi/user-profile` | `recorder.ts`、`anonymizer.ts`、`query.ts`、`index.ts` | 订阅事件：`session.started` → 立即落库并 emit `user.input.recorded`；`step.ended` → 提取 thought/action 摘要（thinking 概括 ≤200 字符）；`user.feedback.captured` → 追加 feedback；`session.ended` → outcome+metrics，状态置 completed，emit `user.interaction.updated`。提供按 sessionId/userId 查询；retention-days 清理。 |
| `@mazi/strategy-full-loop` | `full-loop.ts`、`index.ts` | 实现 core `HarnessStrategy`：run(ctx) 生成器编排 plan→(capacity→executeTurn→机械验收)→failureSignals 处理（retry 计数上限 / abort-turn）。emit `strategy.selected`。不做自动升降级。 |
| `@mazi/harness-runtime` | `runtime.ts`、`config.ts`、`index.ts` | 装配：读 providers/tools/flags JSON → 建 EventBus/SqliteStore/FlagSnapshot/ProviderPool/Router/PolicyEngine/ToolRunner/Recorder/Planner/Executor/Recovery → `run(input, opts)`：建 Session（冻结 Flag）→ recorder 建记录 → FullLoopStrategy 执行 → 返回结果；提供 `recordFeedback`。 |
| `apps/cli` | `main.ts`、`args.ts`、`config.ts`、`index.ts` | `parseArgs` 子命令 `run <input>`（选项 --user/--config-dir/--interactive/--event-dir/--db）；加载配置；执行后打印结果摘要；`--interactive` 下提示用户评分（1–5，可选文本）并经 runtime.recordFeedback 捕获。 |

### 3.3 移除/未建包（MVP 不实现）

- `observer`、`reflector`：观察直接使用工具返回值；验收为机械判定。
- `strategy-plan-execute` / `strategy-react-only`：仅 Full-Loop。
- `apps/server`：仅 CLI。

---

## 4. 已完成基线与校正项

### 4.1 F1 Monorepo（已完成）

pnpm workspace + TypeScript + turbo + biome + vitest 已就绪（提交 `3e04087 monorepo` 等）。**注意**：`package.json engines` 声明 node >=26，但本机实测 v24.19.0 亦可运行（node:sqlite 可用）；如需下调 engine 约束属独立任务，不在本 MVP 范围内，仅登记。

### 4.2 F2 core 契约（已完成，附 1 个校正 Feature F2.1）

`packages/core/src` 14 个契约文件已实现并与 v1.2 §3 对齐（含 v1.2 新增的 `rawInput`/`inputTimestamp`/`UserFeedback`）。逐项 diff 发现以下**待校正/补充**点，作为独立 Feature **F2.1**（实施阶段第一项，单提交）：

1. `user-interaction.ts`：v1.2 中 `userId?: string`（可选），core 实现为必填 —— 校正为可选，匿名化时可省略。
2. `memory.ts`：`MemoryStore` 缺少 `user_interactions` 相关接口（v1.2 §7.2 需要）—— 增加 `saveUserInteractionRecord / loadUserInteractionRecord / listUserInteractionRecords` 方法。
3. 缺工具注册与执行接口（planner 与 executor 共用，避免跨包重复）—— 新增 `tool.ts`：`ToolRegistry`（按 nameOrCapability 解析为 ToolSpec[]，返回 `ToolResolution`{tools, missingRequired, missingOptional}）与 `ToolInvoker`（name→执行函数，返回可判别联合 `ToolExecutionResult`，无 null 返回值）。
4. 补 **core 类型级测试**（AGENT.md 测试先行）：新增 `packages/core/src/contracts.test.ts`，用结构断言核对关键字段，保证契约与 v1.2 同步（回归哨兵）。
5. `session.ts` 中 `Step.payload` 已含 Thinking/ToolCall/Observation 载荷 —— 已满足 v1.2 §3.1，无需改。
6. 全仓需要 ULID 生成（sessionId/turnId/stepId/eventId/recordId）—— core 新增唯一运行时工具 `id.ts`：`ulid()`（48 位单调时间戳 + 80 位随机，Crockford Base32），零外部依赖；`index.ts` 相应导出。

> 判定：其余契约与 v1.2 一致，仅以上 6 项。若实施中发现新偏差，须先更新本档再改码（AGENT.md）。

### 4.3 存储表结构（D1 落点，memory 包 schema.ts 定义）

| 表 | 主键 | 关键列 |
| -- | ---- | ------ |
| sessions | session_id | raw_intent, goal_json, strategy_id, state, flag_snapshot_json, turn_ids_json, aggregate_json, created_at, ended_at, outcome |
| turns | turn_id | session_id, contract_json, capacity_json, step_ids_json, status, attempt, checkpoint_json |
| steps | step_id | turn_id, session_id, seq, kind, payload_json, model_json, usage_json, status, error_json, decision_context_json, started_at, ended_at |
| user_interactions | record_id | session_id, user_id, raw_input, input_timestamp, thought_trace_json, action_trace_json, feedback_json, outcome_json, metrics_json, tags_json, status, updated_at |

索引：turns(session_id)、steps(turn_id, seq)、user_interactions(session_id)、user_interactions(user_id)。

---

## 5. 关键流程规格（MVP）

### 5.1 端到端（对应 v1.2 §11 裁剪）

```
用户输入 (CLI: mazi run "<input>")
  │
  ▼ [harness-runtime.run]
  ├─ 建 Session（求值并冻结 FlagSnapshot；session.flagSnapshot）
  ├─ user-profile recorder：session.started → 立即落库 UserInteractionRecord(recording, rawInput 原样保留)
  │     └─ emit user.input.recorded
  ├─ GoalFactory：goal ← GoalContract(statement=input, allowedTools=配置工具域,
  │       permissionCeiling=read-only/draft(配置), budget+reserveRatio=0.2, strategyHints=[complex])
  ├─ strategy.selected (full-loop)
  ├─ planner.plan(goal)：派生 1 个 TurnContract → 三条派生校验 → 均分切片
  │     └─ emit plan.created / plan.invalid(失败则终止)
  ├─ per Turn:
  │   ├─ planner.assembleCapacity(turn) → SimpleRouter(读 turn.tags)
  │   │     emit provider.selected / provider.fallback / capacity.assembled / capacity.degraded
  │   ├─ executor.executeTurn(turn, capacity)
  │   │     ├─ Step 循环: thinking | tool_call | observation
  │   │     ├─ 采集点 A: ContextMeter → runtime 段
  │   │     ├─ driver.stream: 采集点 B → vendor 段 + timing
  │   │     ├─ 采集点 C: CostCalculator → cost 段；漂移回填
  │   │     ├─ tool_call: PolicyEngine 校验 → tool.invoke → tool.result / tool.blocked
  │   │     ├─ Step 落库 + usage 挂载 + 更新 TurnCheckpoint
  │   │     └─ 终止判定（maxSteps/timeout/success.conditions 机械满足）
  │   ├─ 机械验收对照 turn.contract.success → turn.ended (succeeded/failed)
  │   └─ 失败: failureSignals[retry] 且 attempt<maxRetries → 重试；否则 abort-turn
  ├─ session.ended: 聚合指标 + recorder 完成记录(completed, outcome, metrics)
  │     └─ emit user.interaction.updated
  └─ 返回 { sessionId, outcome, summary, metrics }
```

### 5.2 Usage 三段采集口径（MVP 收紧）

- 每个**含 LLM 调用的 Step** 必须挂载完整 `Usage`（vendor + runtime + cost + timing），与 v1.2 验收 #5 一致；非 LLM 的 observation step 可不挂。
- runtime 段必含：totalContextTokens、systemPromptRatio、contextWindowUtilization、contextDeltaFromPrev、strategyApplied（MVP 恒为 []）。
- cost：仅 base 单价（tier 不生效）：`inputCostUsd = inputTokens/1e6 * inputPerMTok`（cache/reasoning 若有 vendor 数则计，无则 0）。`priceTierApplied="base"`，`pricingVersion` 取 `pricing.version`。
- 漂移：`estimationDriftTokens = |totalContextTokens − vendor.inputTokens|`；>5% 记 warn 日志（MVP 不自动切换 tokenizer）。
- 聚合：`turn.aggregate ← Σ steps usage`；`session.aggregate ← Σ turns + contextStrategyInvocations 计数`（MVP 计数恒 0）。

### 5.3 Policy 校验顺序（同步，命中即拒）

1. `toolName ∈ capacity.tools`？ 否 → `tool.blocked`
2. `tool.minPermission ≤ capacity.permission`？ 否 → `tool.blocked`
3. 参数过 mini JSON-Schema 校验？ 否 → `tool.blocked`（schema-violation）
4. `tool.irreversible === true`？ 是 → `tool.blocked`（MVP 无审批门）
5. `goal.constraints` 全部满足（内置 network / forbidden-resource 解释；未知 kind 存在即拒）？ 否 → `policy.denied`
6. 预算：`turn 累计成本 + 本次预估 ≤ capacity.budget.maxCostUsd`？ 否 → `budget.exceeded`

每条校验 emit 对应事件（`policy.check`/`policy.denied`/`tool.blocked`/`budget.exceeded`），由 executor 负责 emit（policy 包只返回 verdict）。

### 5.4 Checkpoint / 恢复

- 每个 Step `ended` 后：`checkpoint = { lastCompletedStepSeq, pendingStepIds, accumulatedUsage, accumulatedCostUsd, savedAt }` 落库。
- 恢复（模拟崩溃）：进程重启 → `recovery.resumeTurn(turnId)` → 加载 Turn + 已完成 Steps → 用 Steps 重建对话上下文与累计 Usage → 从 `lastCompletedStepSeq+1` 继续。
- 前提：工具结果已作为 observation Step 持久化，恢复时不重新调用已完成的工具（幂等假设记录于 §7）。

### 5.5 用户交互记录更新规则

| 事件 | 记录动作 |
| ---- | -------- |
| session.started | 创建 record（recording），rawInput 原样、inputTimestamp=now；若 Flag `user-profile.anonymize`=true → userId 省略、rawInput 经匿名化管道（默认 sha256 摘要前缀） |
| step.ended(thinking) | 追加 ThoughtSummary（摘要 ≤200 字符，category 启发式） |
| step.ended(tool_call) | 追加 ActionSummary（actionType=tool_call，result 取 status ok/error/blocked） |
| user.feedback.captured | 追加 UserFeedback（type/content/rating/target） |
| session.ended | 写 outcome、metrics（durationMs/totalTokens/totalCostUsd/turnCount），status=completed |
| user.input.recorded / user.interaction.updated | 由 recorder 在创建/完成时 emit（异步不阻塞主流程） |

Flag：`user-profile.enabled`（默认 true）、`user-profile.anonymize`（默认 false）、`user-profile.retention-days`（默认 0=永久）。

---

## 6. MVP 验收标准

| # | 验收项 | 标准 |
| - | ------ | ---- |
| A1 | 三层观测完整性 | 任意事件含 sessionId；Turn/Step 级事件含对应 ID；缺必填即报错（observability 构造期校验） |
| A2 | 两级契约校验 | 构造 requiredTools ⊄ allowedTools 或 maxPermission > ceiling 的 TurnContract，Planner 拒绝并 emit `plan.invalid` |
| A3 | 预算守恒 | Σ 切片 ≤ 全局 × (1 − reserveRatio)；单 Turn 时切片=可分配预算；下限 MIN_TURN_BUDGET_USD=$0.01 生效 |
| A4 | 路由信号下沉 | Provider 选择只读 turn.contract.tags；GoalContract 无路由字段（core 已保证类型层，路由测试再验证） |
| A5 | Usage 双层完整 | 每个含 LLM 的 Step：vendor + runtime + cost + timing 齐备；runtime 含 systemPromptRatio/contextWindowUtilization/contextDeltaFromPrev |
| A6 | Cost 可追溯 | cost 计算可回溯 pricingVersion；tier 不生效时 priceTierApplied="base" |
| A7 | Policy 拦截 | 白名单外工具、权限不足、参数不合 schema、不可逆工具、超预算 —— 均被拦截并 emit 对应事件，工具不执行 |
| A8 | Flag 关闭 ≠ 数据丢失 | `observe.enabled=false`（或 console.sink=false）时 JSONL 仍含完整事件流水 |
| A9 | 断点恢复 | 模拟 Turn 中途崩溃后 resume，跳过已完成 Step（工具不重复执行），从断点继续 |
| A10 | 用户记录 | Session 创建即生成 recording 记录含原始输入；结束后 completed，含 outcome/metrics；feedback 可捕获追加 |
| A11 | 路由与故障转移 | ScriptedDriver 首选失败时自动切次优 Provider，emit provider.fallback |
| A12 | 装配即用 | 外部只调 `runtime.run(input)` 即完成全流程并返回结果；配置全部可注入 |
| A13 | 代码结构 | core dependencies 为空、可独立编译；provider-llm 无真实厂商强依赖（Driver 注入）；L1 包间零依赖 |
| A14 | 端到端 | CLI `mazi run` 使用 ScriptedDriver 完成示例任务（读取文件并汇报），产出结果、事件、Usage、用户记录齐全 |
| A15 | 质量门禁 | 每个 Feature 提交前：相关测试 `pnpm vitest run` 通过、`pnpm biome check` 触碰文件无告警、禁止混合提交 |

---

## 7. 风险与限制（MVP 承认的取舍）

1. **无真实 LLM 验证**：全链路基于 ScriptedDriver 验证，厂商 usage/延迟为模拟值；真实适配前不得宣称厂商兼容。
2. **工具执行无沙箱隔离**：工具在宿主直接执行；MVP 仅放行只读/无副作用工具（`fs.read` 等），配置即信任边界。
3. **估算 tokenizer 误差**：char/4 估算可能偏差 >5%，MVP 仅告警不自动切换。
4. **恢复依赖幂等假设**：崩溃若发生在工具执行内部（非 Step 边界），不重复执行已记录成功的 Step；工具自身副作用幂等由配置保证。
5. **单 Turn 限制**：多步任务需重规划或真实 LLM 才能拆解，MVP 仅演示单 Turn 全链路。
6. **无审批门**：高权限/不可逆操作不可执行，通过权限天花板与工具白名单收敛。

---

## 8. Feature 拆解与实施顺序

**Feature 完成定义（DoD，每项强制，对应 AGENT.md）**：① 本档相关小节无需改动即按文档实现（若发现文档缺口，先更新本档再编码）；② 先写测试或用例（test first），测试覆盖正常/边界/异常；③ 实现；④ `pnpm vitest run <相关>` 通过；⑤ `pnpm biome check` 触碰文件通过；⑥ 单 Feature 单原子提交（Conventional Commits，scope=包名），提交信息注明文档依据小节。

| ID | Feature（scope） | 状态 | 依赖 | 内容要点 |
| -- | ---------------- | ---- | ---- | -------- |
| F1 | monorepo 初始化（root） | ✅ 已完成 | — | pnpm workspace / tsconfig / turbo / biome / vitest / husky |
| F2 | core 契约（core） | ✅ 已完成 | F1 | 14 契约文件 + index（提交 9caf2c9） |
| F2.1 | core 校正与类型测试（core） | ✅ 已完成 | F2 | §4.2 五项：userId 可空、MemoryStore 增 user_interactions 接口、ToolRegistry/ToolInvoker 接口、contracts.test.ts 哨兵 |
| F3 | observability：EventBus + JSONL 落盘 | ⏳ | F2.1 | event-bus/FileSink/异步队列/replay；测试：emit 落盘、filter、重载回放、console.sink 不影响落盘（A1/A8） |
| F4 | flags：求值 + 快照 + 默认集 | ⏳ | F2.1 | evaluator/snapshot/bucket/默认 Flag 集；测试：规则优先级、session 冻结、默认回退 |
| F5 | provider-llm：Driver + ProviderPool + SimpleRouter | ⏳ | F2.1, F4 | ScriptedDriver、registry、router、fallback；测试：能力过滤/价格排序/故障转移/事件回调（A4/A11） |
| F6 | usage：tokenizer/meter/计价/聚合 | ⏳ | F2.1, F5 | 估算 tokenizer、ContextMeter、CostCalculator、AggregateReducer、漂移回填；测试：计数、计价、漂移阈值（A5/A6） |
| F7 | policy：mini-schema + 校验 | ⏳ | F2.1 | schema-validator、policy-engine；测试：每项拒绝路径 + 通过路径（A7） |
| F8 | memory：node:sqlite 存储 | ⏳ | F2.1 | sqlite-store/schema；测试：session/turn/step/record CRUD + checkpoint（A9 前置） |
| F9 | planner：单 Turn + 派生校验 + 切片 + capacity | ⏳ | F2.1, F4, F5, F6, F7, F8 | planner/budget/tool-resolver；测试：A2/A3、optional 缺失降级、capacity 组装 |
| F10 | executor：Step 循环 + 采集点 + Policy + 工具 | ⏳ | F3–F9 | executor/context-builder/tool-runner/step-loop；测试：ScriptedDriver 场景完整执行、Usage 挂载、tool.blocked 不执行、checkpoint 写入（A5/A7/A14 前置） |
| F11 | recovery：checkpoint 恢复 | ⏳ | F8, F10 | checkpoint/resumer；测试：模拟崩溃 resume 不重执行（A9） |
| F12 | strategy-full-loop：编排 | ⏳ | F9, F10, F11 | full-loop；测试：单 Turn 成功路径、retry/abort 路径、strategy.selected |
| F13 | user-profile：recorder + 查询 | ⏳ | F3, F8 | recorder/anonymizer/query；测试：即时创建、更新规则、anonymize、completed（A10） |
| F14 | harness-runtime：装配 | ⏳ | F4–F13 | runtime/config；测试：run() 全流程 wiring（A12/A13） |
| F15 | cli：mazi run + 反馈捕获 | ⏳ | F14 | args/config/main；手动验收：示例任务（A14） |
| F16 | 端到端集成测试与文档 | ⏳ | F15 | e2e 场景（含 policy 拒绝路径、feedback、恢复）、README、配置示例；全部 A1–A15 通过 |

**实施顺序硬约束**：F2.1 → F3/F4（可并行）→ F5–F8（依赖 F2.1，可并行）→ F9 → F10 → F11 → F12 → F13（与 F12 可并行）→ F14 → F15 → F16。禁止跳序（如先实现 executor 再改 memory 契约属跨范围修改）。

每个 Feature 的 commit 建议（按 D6）：`feat(observability): EventBus + JSONL FileSink（MVP v1.0 §8 F3）`、`feat(policy): ...`。F2.1 允许单独 `feat(core): 契约校正…`（契约变更在 core 内先行评审）。

---

## 9. 配置示例（实施后落到 apps/cli/config/ 与 examples/）

```jsonc
// config/providers.json —— 示例定价仅示意；MVP 无真实厂商，driver 类型为 scripted
{
  "providers": [
    {
      "id": "scripted-a",
      "vendor": "scripted",
      "driver": { "type": "scripted", "scenario": "./examples/scenario-read-file.json" },
      "tags": ["tools"],
      "models": [{ "id": "scripted-1", "contextWindow": 64000, "supportsTools": true, "supportsThinking": true, "supportsVision": false }],
      "pricing": { "currency": "USD", "base": { "inputPerMTok": 0.5, "outputPerMTok": 1.5 }, "tiers": [], "effectiveAt": 0, "version": "0.0.0-scripted" },
      "health": { "score": 1.0 }
    }
  ]
}
```

```jsonc
// config/tools.json
{
  "tools": [
    { "name": "fs.read", "description": "读取文件内容", "parameters": {
        "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] },
      "minPermission": "read-only", "irreversible": false, "sideEffects": ["fs"] }
  ]
}
```

```jsonc
// config/flags.json —— 未配置项取 flags 包内置默认值
{
  "flags": [
    { "key": "observe.enabled", "description": "Observer 消费开关（MVP 恒 true，仅演示语义）", "type": "boolean", "defaultValue": true },
    { "key": "console.sink", "description": "控制台事件打印", "type": "boolean", "defaultValue": true }
  ]
}
```

ScriptedDriver 场景示例（`examples/scenario-read-file.json`）结构（schema 由 provider-llm 定义并测试）：
第一轮输出 tool_call fs.read（path=README.md）→ 下一轮输出文本并携带模拟 vendor usage。

---

## 附录 A：旧文档评审结论（v0.1 草稿 + 执行计划的勘误）

| # | 位置 | 旧描述 | 问题 | 本版处置 |
| - | ---- | ------ | ---- | -------- |
| E1 | MVP v0.1 §2.1 / 执行计划 F5 | “pi-ai 适配”、“可成功调用配置的任一 Provider” | 仓库无 pi-ai 依赖、无凭据，不可验证 | D3：Driver 注入 + ScriptedDriver；真实适配留后续 Feature |
| E2 | MVP v0.1 §3.1 / 执行计划 F8 | “SQLite（单文件）或简单 JSON”、“better-sqlite3 或 sqlite3” | 未锁定、引入原生依赖风险 | D1：node:sqlite，表结构 §4.3 锁定 |
| E3 | MVP v0.1 §3.4 / 执行计划 F7 | “参数 schema 校验（使用 TypeBox 验证）” | TypeBox 未安装，无依据新增依赖 | D4：policy 内置 mini JSON-Schema 子集校验器 |
| E4 | 执行计划 F15 | “使用 commander 或手动解析” | 未锁定 | D4：node:util parseArgs |
| E5 | MVP v0.1 §6 | 里程碑 M1.1–M1.4 按周划分，任务粗粒度 | 与“单 Feature 单提交”不可映射 | §8 Feature 拆解，粒度=提交单元；标注 F1/F2 状态 |
| E6 | MVP v0.1 §3.2 | “可由简单规则或调用 LLM 生成计划” | 未澄清 MVP 具体行为 | D7：默认单 Turn 线性分解 |
| E7 | MVP v0.1 §3.3 | 路由“获取 tags 中的能力要求”表述模糊 | 能力匹配口径不清 | §3.2/§5.1：CapabilityTag ∈ turn.tags ∩ provider 能力，health>0.5，价格升序 |
| E8 | MVP v0.1 §3.4 | irreversible “直接拒绝或降级为只读” | 二义性 | D8：一律 tool.blocked |
| E9 | MVP v0.1 §3.6 | 事件列表不完整（缺 user.interaction.updated 等） | 与 core HarnessEventType 全集不一致 | EventBus 支持 core 全量类型；MVP 流程必发集合见 §5 |
| E10 | MVP v0.1 §附录 | providers.json 示例为真实模型与实时价格 | 价格易过时且误导（无真实接入） | §9 改为 scripted 示例 + 注明“示例定价仅示意” |
| E11 | MVP v0.1 §1 | 未含“三方记录/审计”对齐项（v1.2 验收 #1/#13） | 与 v1.2 验收脱节 | §6 A1/A6/A13 覆盖三层 ID、usage、capacity 落库与成本可追溯 |
| E12 | 执行计划 F2 | “编写基础类型测试（可选）” | 违反 AGENT.md 测试先行 | F2.1 强制 contracts.test.ts 类型哨兵 |
| E13 | 根 package.json engines | node >=26.0.0 | 本机 v24.19.0 实际可用 | 登记待后续单独任务下调，不在 MVP 范围内改动 |

---

本 MVP 设计文档 v1.0 基于总体设计 v1.2 裁剪；若实施中发现与总体设计或本档不一致之处，一律先更新文档、评审后再改代码。
