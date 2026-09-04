
# AI Agent Harness MVP 设计文档

> **版本**：v0.1（基于总体设计 v1.2 裁剪）
> **目标**：快速验证核心执行闭环，具备基础可观测性、可恢复性与用户记录能力，为后续迭代提供稳定骨架。

---

## 1. MVP 目标

在最小工程投入下，实现一个可运行的 Agent Harness，满足以下核心能力：

- 接收用户输入，创建 Session，生成 GoalContract（简化版）。
- 使用单一策略（full-loop 或简化的 plan-execute）驱动任务执行。
- 支持简单的 Planner：将目标分解为 1~N 个 Turn，生成 TurnContract（仅做派生校验，不做复杂预算加权）。
- Provider 路由采用**能力过滤 + 成本排序**的简单模式。
- Policy Engine 提供基础拦截：工具白名单、权限校验、预算检查（不包含审批门）。
- Usage 双层采集：Vendor（厂商返回）与 Runtime（上下文分段计数，使用估算 tokenizer）。
- 事件系统：所有事件 emit 并强制持久化到 JSONL 文件（不可关闭）。
- Checkpoint 断点续传：进程崩溃后能从最近的 TurnCheckpoint 恢复。
- 用户交互记录：Session 创建时立即记录原始输入，过程中持续更新 thoughtTrace/actionTrace/feedback，结束时写入 outcome 与 metrics。
- 提供 CLI 应用作为演示入口。

**明确不包含**（延后到后续版本）：

- 审批门（approval.gate）与不可逆操作的审批流程。
- 独立 Reflector 与 LLM-as-judge 评估。
- 六因子路由、分时定价、经济画像（Provider 路由只做基础）。
- 预算加权切片、策略自动升降级、A/B 实验平台。
- 复杂上下文策略（summarize/compress 等）。
- 多策略支持（仅实现一个策略，但架构上保留接口）。

---

## 2. 架构裁剪

保留总体设计中的 L0/L1/L2 必要模块，移除或简化 L3/L4。

### 2.1 保留的包

| 包名                            | 说明                                                                | 简化内容                                            |
| ------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/core`               | 全部契约类型，零运行时依赖                                          | 使用完整定义，但 MVP 不使用的字段可保留但不实现逻辑 |
| `packages/provider-llm`       | pi-ai 适配，ProviderPool，简单路由                                  | 仅实现 Driver 和简单路由器                          |
| `packages/usage`              | Tokenizer 注册表（估算），成本计算器，Aggregator                    | 简化成本计算：仅支持基础价格，不考虑时段            |
| `packages/observability`      | EventBus + JSONL 持久化 sink                                        | 仅实现 emit/subscribe/replay 基本功能               |
| `packages/flags`              | Flag 求值器                                                         | 支持默认 Flag 集，无 A/B 分桶（可预留接口）         |
| `packages/policy`             | 基础 Policy Engine（工具白名单、权限、预算）                        | 不包含审批门，仅同步校验                            |
| `packages/memory`             | 简单的持久化存储（SQLite 或文件）                                   | 仅保存 Session/Turn/Step/Checkpoint，无检索         |
| `packages/planner`            | 简化 Planner：线性分解 + 派生校验 + 均分预算                        | 不实现预算加权和复杂切片                            |
| `packages/executor`           | Step 执行器 + 采集点 A                                              | 不包含沙箱隔离（直接调用工具）                      |
| `packages/recovery`           | Checkpoint 管理、恢复调度                                           | 基础实现：进程重启后加载 Checkpoint                 |
| `packages/user-profile`       | 用户交互记录创建与更新                                              | 无画像聚合分析，只记录原始数据                      |
| `packages/strategy-full-loop` | 唯一策略实现：简化版 full-loop（Goal→Plan→Execute→简单 Reflect） | Reflect 仅为结果成功/失败判定                       |
| `packages/harness-runtime`    | 装配器，将各模块连接                                                | 手动 wiring，不实现自动策略选择                     |
| `apps/cli`                    | CLI 入口，接收用户输入并运行                                        | 交互式或单命令模式                                  |

### 2.2 移除的包（MVP 不实现）

- `packages/observer`：观察层简化，直接使用工具返回值。
- `packages/reflector`：独立评估器，MVP 中仅做机械验收判定。
- `packages/strategy-plan-execute` / `strategy-react-only`：MVP 只实现 full-loop。
- `apps/server`：不提供 HTTP 服务，仅 CLI。

### 2.3 依赖关系

```
core (L0)
  ↑
provider-llm, usage, observability, flags, policy, memory (L1)
  ↑
planner, executor, recovery, user-profile (L2)
  ↑
strategy-full-loop (L3)
  ↑
harness-runtime (L3.5)
  ↑
apps/cli (L4)
```

所有依赖严格单向，L1 包之间不互相依赖，仅通过 core 协作。

---

## 3. MVP 核心设计

### 3.1 Session / Turn / Step 持久化

- **存储**：使用 SQLite（单文件）或简单的 JSON 文件存储（为 MVP 简化，推荐 SQLite 便于查询）。
- **表结构**：
  - `sessions`：sessionId, userId, rawIntent, goalJson, strategyId, state, flagSnapshotJson, createdAt, endedAt, outcome
  - `turns`：turnId, sessionId, contractJson, capacityJson, stepIdsJson, status, attempt, checkpointJson
  - `steps`：stepId, turnId, sessionId, seq, kind, payloadJson, modelId, usageJson, status, errorJson, startedAt, endedAt
  - `user_interactions`：recordId, sessionId, userId, rawInput, inputTimestamp, thoughtTraceJson, actionTraceJson, feedbackJson, outcomeJson, metricsJson, status, updatedAt
- **恢复**：Session 启动时加载所有相关 Turn/Step；Turn 执行前检查 checkpoint，若有则跳过已完成 Step。

### 3.2 GoalContract 与 TurnContract 简化

MVP 仍然使用完整的 GoalContract 和 TurnContract 类型，但生成逻辑简化：

- GoalContract 由应用层直接构造（用户输入 → 简单解析，不调用模型生成）。
- 约束（constraints）默认为空数组，或由 CLI 参数提供简单约束（如禁止网络）。
- 预算：`maxTurns`, `maxSteps`, `maxCostUsd` 可选，默认不限制但设置合理上限。
- 策略提示 strategyHints 仅用于标记任务复杂度（'simple' | 'complex'），MVP 中忽略。
- Planner 将目标分解为线性 Turn 序列（可由简单规则或调用 LLM 生成计划）。MVP 中为降低复杂度，可**只生成一个 Turn**，即整个目标作为一个子任务。后续版本再支持多 Turn。
- TurnContract 包含：

  - `statement`：等于 GoalContract.statement。
  - `tags`：由 CLI 或简单分类器设置（例如 'general'）。
  - `success`：简单验收，例如“执行无错误且返回结果”。
  - `requiredTools`：由用户输入推断（如需要读取文件则包含 'fs.read'）。
  - `maxPermission`：默认 'read-only' 或 'draft'。
  - `budget`：均分全局预算（MVP 中只有一个 Turn，即全部预算）。
  - `failureSignals`：默认包含 tool-error 和 budget-exceeded，action 为 'abort-turn' 或 'retry'。
  - `termination`：maxSteps 默认 10。

### 3.3 Provider 路由（简单模式）

- 从 `packages/provider-llm` 的 ProviderRegistry 读取已配置的 Provider 列表（从环境变量或配置文件加载）。
- 对每个 Turn，获取其 `tags` 中的能力要求（如需要 tools 支持）。
- 过滤：选择支持所需能力且健康评分 > 0.5 的 Provider。
- 排序：按基础价格（`pricing.base.inputPerMTok + outputPerMTok` 的简单组合）升序排列，选择价格最低者。
- 故障转移：若首选 Provider 调用失败，按顺序尝试下一个。
- 路由决策记录在 `provider.selected` 事件中。

### 3.4 Policy Engine 基础拦截

- 在 `executor` 执行 `tool_call` 前调用 Policy Engine。
- 校验项：
  1. 工具是否在 `Capacity.tools` 白名单内。
  2. 所需权限是否满足（`toolSpec.minPermission <= capacity.permission`）。
  3. 参数 schema 校验（使用 TypeBox 验证）。
  4. 预算检查：当前 Turn 累计成本 + 预估成本 <= capacity.budget.maxCostUsd。
- 若任一失败，emit `tool.blocked` 或 `policy.denied`，停止该 Step 并触发失败处理。
- MVP 不实现审批门，若工具 `irreversible=true` 则直接拒绝或降级为只读（根据 Flag `sandbox.enabled` 决定）。

### 3.5 Usage 双层采集

- **采集点 A**（context 组装）：在 `executor` 构建 LLM 请求前，使用 `usage` 包的 `context-meter` 计算各段 token 数。MVP 中使用估算 tokenizer（字符数/4）。生成 `RuntimeContextBreakdown`。
- **采集点 B**（LLM 响应）：`provider-llm` 的 driver 在流结束时捕获厂商返回的 usage（若 pi-ai 提供），填充 `VendorUsage`。若厂商未返回，则 `reportedByVendor=false`，使用估算值。
- **采集点 C**（成本计算）：`usage` 包的 `cost-calculator` 根据 Provider 的 `pricing.base` 计算成本（不考虑时段），生成 `CostBreakdown`，并将完整 Usage 挂到 Step。
- Aggregator 在 Turn 结束时累计 Usage，在 Session 结束时汇总。

### 3.6 事件系统与持久化

- 实现 `EventBus`：
  - `emit(event)`：将事件推送到所有订阅者，并异步写入 JSONL 文件（路径由环境变量 `EVENT_LOG_DIR` 指定，若未设置则写入当前目录 `./events`）。
  - `subscribe(filter, sink)`：订阅者接收符合条件的事件。
  - `replay(sessionId)`：从 JSONL 文件中过滤该 session 的事件返回。
- 事件类型：MVP 至少支持以下事件：
  - `session.started`, `session.ended`
  - `turn.started`, `turn.ended`
  - `step.started`, `step.ended`
  - `llm.request`, `llm.response`
  - `tool.invoke`, `tool.result`, `tool.blocked`
  - `policy.check`, `policy.denied`
  - `provider.selected`, `provider.fallback`
  - `plan.created`, `plan.invalid`
  - `capacity.assembled`
  - `budget.exceeded`
  - `user.input.recorded`, `user.feedback.captured`
- 所有事件必须包含 `sessionId`，Turn/Step 级事件包含 `turnId`/`stepId`。

### 3.7 Checkpoint 与恢复

- Executor 在每个 Step 成功结束后更新 Turn 的 Checkpoint，并持久化到 `turns` 表（`checkpointJson` 字段）。
- Checkpoint 内容包括：`lastCompletedStepSeq`, `pendingStepIds`, `accumulatedUsage`, `accumulatedCostUsd`。
- 进程重启或 Turn 重新开始时，Recovery 模块读取 Checkpoint，若存在且状态为 `running`，则跳过已完成的 Step，继续执行。
- 为简化，MVP 中假设工具调用具有幂等性，或不做额外处理。

### 3.8 用户交互记录

- `UserInteractionRecord` 在 Session 创建时立即创建（状态 `recording`），保存 `rawInput` 和 `inputTimestamp`。
- `user-profile` 包订阅事件总线，监听以下事件并更新记录：
  - `step.ended`：从 Step 的 payload 中提取 `thoughtTrace`（若有 thinking）和 `actionTrace`（tool_call）。
  - `approval.granted` / `approval.denied`：MVP 未实现审批，可忽略。
  - `user.feedback.captured`：当 CLI 捕获到用户反馈（例如在交互中用户输入“停止”或打分）时 emit，更新 feedback 数组。
  - `session.ended`：写入 outcome 和 metrics（durationMs, totalTokens, totalCostUsd, turnCount），状态置 `completed`。
- MVP 中用户反馈可通过 CLI 交互输入：在 Session 执行过程中，用户可以按 Ctrl+C 中断并输入反馈，或系统在关键决策时询问用户（不实现审批，但可以询问“是否继续？”并记录用户选择）。

### 3.9 策略实现（Full-Loop 简化）

- `strategy-full-loop` 包实现 `HarnessStrategy` 接口。
- 流程：
  1. `Planner.plan(goal)` → 生成 TurnContract（可能仅一个 Turn）。
  2. 对每个 Turn：
     - `Planner.assembleCapacity(turn)` → 选择 Provider，解析工具，生成 Capacity。
     - `Executor.executeTurn(turn, capacity)` → 循环执行 Step，直到满足终止条件或失败。
     - 简单 Reflect：检查 Turn 是否成功（所有 Step 状态 ok 且满足 success 条件），否则按 failureSignals 处理。
  3. 所有 Turn 完成后，Session 结束。
- 不实现 Observe 和 Reflector 作为独立模块，直接在策略中嵌入简单检查。

---

## 4. 端到端流程（MVP 简化）

```
用户输入（CLI 读取）
  │
  ├─ Runtime 创建 Session，求值 Flag 快照
  ├─ user-profile 创建 UserInteractionRecord (recording)
  ├─ 生成 GoalContract（简单解析）
  ├─ 选择策略（固定 full-loop）
  │
  ├─ Planner.plan(goal) → 生成 TurnContract（可能仅一个）
  ├─ 对每个 Turn:
  │    ├─ assembleCapacity → 简单路由 + 工具解析 + 权限
  │    ├─ 循环 Step:
  │    │    ├─ 采集点A (context-meter)
  │    │    ├─ LLM 调用 (provider-llm)
  │    │    ├─ 采集点B (vendor usage) → 采集点C (cost calc)
  │    │    ├─ 若模型输出 tool_call → Policy 校验 → 执行工具 → 工具结果
  │    │    ├─ 更新 Checkpoint
  │    │    └─ 用户可能中断并反馈 → 记录
  │    ├─ Turn 结束，更新状态
  │    └─ 若失败按 failureSignals 处理
  ├─ Session 结束，更新 UserInteractionRecord
  └─ 输出结果到 CLI
```

---

## 5. MVP 验收标准

| #  | 验收项               | 标准                                                                                            |
| -- | -------------------- | ----------------------------------------------------------------------------------------------- |
| 1  | 基础执行             | 给定简单任务（如“读取文件并总结内容”），CLI 能成功执行并返回结果                              |
| 2  | 契约校验             | 构造越权的 TurnContract（requiredTools 不在 allowedTools），Planner 拒绝并 emit`plan.invalid` |
| 3  | 路由简单             | Provider 选择仅基于能力与价格，事件`provider.selected` 被记录                                 |
| 4  | Policy 拦截          | 尝试调用不在白名单的工具，被`tool.blocked` 拦截，不执行                                       |
| 5  | Usage 采集           | 每个含 LLM 的 Step 均挂载 Usage，包含 vendor 和 runtime 段                                      |
| 6  | 事件持久化           | JSONL 文件中包含所有事件，即使 Flag`observe.enabled=false`                                    |
| 7  | 断点恢复             | 模拟进程在 Turn 中途崩溃，重启后能从 Checkpoint 恢复，不重复执行已完成 Step                     |
| 8  | 用户记录             | Session 创建时生成 UserInteractionRecord，结束后状态为 completed，包含原始输入和基本 metrics    |
| 9  | 多 Provider 故障转移 | 首选 Provider 不可用，自动尝试下一个，记录`provider.fallback`                                 |
| 10 | 代码结构             | 包依赖符合架构图，core 无运行时依赖，provider-llm 是唯一外部 LLM 依赖                           |

---

## 6. MVP 里程碑与任务分解

### M1.1 基础骨架（1 周）

- [ ] 初始化 monorepo，配置 pnpm workspace 和 TypeScript。
- [ ] 实现 `packages/core` 全部类型契约。
- [ ] 实现 `packages/flags` 基础求值。
- [ ] 实现 `packages/observability` EventBus + JSONL sink。

### M1.2 执行核心（2 周）

- [ ] 实现 `packages/provider-llm`：Driver 适配 pi-ai，简单 ProviderPool 和路由。
- [ ] 实现 `packages/usage`：context-meter（估算）、cost-calculator、aggregator。
- [ ] 实现 `packages/policy` 基础校验。
- [ ] 实现 `packages/planner`：单 Turn 生成、派生校验、Capacity 组装。
- [ ] 实现 `packages/executor`：Step 循环、工具调用、采集点 A/B/C。
- [ ] 实现 `packages/recovery`：Checkpoint 保存与加载。
- [ ] 实现 `packages/memory`：SQLite 持久化。

### M1.3 策略与集成（1 周）

- [ ] 实现 `packages/strategy-full-loop` 简化策略。
- [ ] 实现 `packages/harness-runtime` 装配。
- [ ] 实现 `apps/cli`：输入解析、调用 runtime、输出结果。

### M1.4 用户记录与打磨（1 周）

- [ ] 实现 `packages/user-profile` 记录创建与更新。
- [ ] 集成用户反馈捕获（CLI 交互）。
- [ ] 测试端到端流程，修复问题。
- [ ] 编写基本文档和示例。

---

## 7. 风险与限制

- **工具调用安全**：MVP 未实现沙箱隔离，工具调用可能在宿主机直接执行，需确保仅使用低风险工具。
- **Token 估算误差**：估算 tokenizer 可能不准确，但 MVP 阶段可接受，后续接入精确 tokenizer。
- **单 Turn 限制**：目前只支持线性单 Turn，无法处理复杂多步骤任务，后续版本扩展。
- **恢复依赖 Checkpoint 粒度**：若在工具执行中崩溃且工具不可幂等，可能导致状态不一致。
- **无审批门**：高权限操作无法执行，需在配置中限制工具集。

---

## 附录：MVP 配置文件示例

```json
// config/providers.json
{
  "providers": [
    {
      "id": "openai-gpt4o-mini",
      "vendor": "openai",
      "models": [{ "id": "gpt-4o-mini", "contextWindow": 128000, "supportsTools": true }],
      "pricing": { "base": { "inputPerMTok": 0.15, "outputPerMTok": 0.60 } },
      "health": { "score": 1.0 }
    },
    {
      "id": "anthropic-claude-haiku",
      "vendor": "anthropic",
      "models": [{ "id": "claude-3-5-haiku", "contextWindow": 200000, "supportsTools": true }],
      "pricing": { "base": { "inputPerMTok": 0.25, "outputPerMTok": 1.25 } },
      "health": { "score": 1.0 }
    }
  ]
}
```

```json
// config/tools.json
{
  "tools": [
    {
      "name": "fs.read",
      "description": "Read file content",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] },
      "minPermission": "read-only",
      "sideEffects": ["fs"]
    }
  ]
}
```

---

本 MVP 设计文档基于总体设计 v1.2 裁剪，聚焦核心闭环，确保快速交付可运行的 Agent Harness 基础，同时为后续扩展保留架构空间。
