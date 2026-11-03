# Agent 评测与长任务可靠性审计

> 日期：2026-11-03
>
> 范围：当前工作区中的 `packages/runtime`、`apps/api` 与 `apps/webui`。
>
> 注意：当前工作区存在未提交的 `packages/eval → packages/runtime/src/eval` 重构，本文按工作区实际代码审计，不代表已提交基线。

## 1. 结论

mazi 当前已经具备 Agent Harness 原生的 Trace、Session 自动评测、固定 Benchmark、AB
对照、权限审批、Step 级恢复和模型调用重试能力，但这些能力还没有完全收敛成统一的
durable execution / evaluation platform。

与 Langfuse 相比，主要差距不在 Trace，而在：

1. 通用 Score / Evaluator 数据模型；
2. 动态 Dataset 与实验闭环；
3. 在线评测规则、采样和批量回填；
4. 人工标注与 Judge 校准；
5. Score Analytics、告警和 CI 回归门禁。

长任务可靠性方面，Provider 层最成熟；Goal/Task/Tool/API 层存在不同等级的缺口：

| 能力 | 当前成熟度 | 判断 |
| --- | --- | --- |
| 模型超时、重试、failover、熔断 | 较完整 | Provider 层已有策略表和测试 |
| 用户取消 | 部分完整 | 模型调用可中断；审批和运行中工具不能立即中断 |
| Step checkpoint / 手动恢复 | 较完整 | 复用 Task/Step，pending 调用可续跑 |
| 进程崩溃后恢复 | 缺失 | 当前明确不在自动恢复范围内 |
| 工具幂等 | 部分 | 同 Task 成功调用可去重，跨进程与不确定副作用仍不安全 |
| HTTP 请求幂等 | 缺失 | 没有 Idempotency-Key / 请求去重账本 |
| Goal 级 deadline | 缺失 | 契约有 `timeoutMs` 字段，但执行层未落实 |
| Eval 超时 | 弱 | 只让 Promise 超时，不中止底层运行 |

## 2. Eval 与 Langfuse 的差距

Langfuse 当前把评测定义成完整闭环：

```text
Trace / Observation
  → Evaluator / Rule
  → Score
  → Dataset
  → Experiment
  → Annotation / Analytics / Alert / CI
```

mazi 当前主要是：

```text
Goal / Task / Step
  → Session Eval 固定投影
  → Eval Dashboard

固定任务 JSON → Benchmark
AB 两臂 → 对照实验
```

### 2.1 能力矩阵

| 能力 | mazi 当前 | Langfuse 当前 | 优先级 |
| --- | --- | --- | --- |
| Trace / Session | Goal/Task/Step、工具、审批、成本 | Trace/Observation/Session/Tool/Generation | 已有优势 |
| Score | 固定 SessionEvaluationRecord / EvalTaskResult | 通用 Score，支持 Numeric/Categorical/Boolean/Text，可挂 Trace/Observation/Session/Run | P0 |
| Evaluator | 固定投影、机械 Verifier、Semantic Judge seam | Code、LLM Judge、Decision Model、API/SDK、人工 | P0 |
| Online Evaluation | 每次 Session 自动计算固定指标 | 过滤规则、采样、多个 Evaluator、历史回填 | P0 |
| Dataset | 固定 `p0-baseline.json` | 动态 CRUD、expected output、metadata、多模态、生产 Trace 入库 | P0 |
| Experiment | 固定 Benchmark + 两臂 AB | Dataset × Task × Evaluator，多 Run 比较，UI/SDK/OTel | P1 |
| Human Review | 用户反馈与人工审批 | Score Config、Annotation Queue、负责人、纠正输出 | P1 |
| Analytics | 基础 KPI，前端聚合 | 趋势、分布、相关性、人工/Judge 一致性 | P1 |
| Prompt Management | PromptPack 当前状态持久化 | 版本、环境标签、变量、缓存、Playground、Trace 关联 | P1 |
| Alert / CI | 暂无 Eval 阈值告警和回归门禁 | Score/Cost 告警、Experiment GitHub Action | P2 |

### 2.2 第一优先缺口：通用 Score

当前一次运行只有一个聚合型 `SessionEvaluationRecord`。建议引入独立 Score：

```text
Score
  id
  name: correctness | policy_pass | helpfulness | ...
  valueType: numeric | categorical | boolean | text
  value
  scope: trace | observation | task | session | experiment_run
  source: human | code | llm_judge | decision_model | user_feedback | api
  evaluatorId / evaluatorVersion
  comment
  evidence
  createdAt
```

这一步是 Dataset、Experiment、人工标注和 Score Analytics 的共同基础。

### 2.3 第二优先缺口：Dataset 与 Experiment

目标 Dataset 至少支持：

- 创建、编辑、删除、版本化；
- `input`、`expectedOutput`、`metadata`；
- 从失败 Trace/Session 一键加入；
- 批量导入与导出；
- 按项目隔离。

目标 Experiment 至少支持：

- 同一 Dataset 上运行多组 model / PromptPack / code version；
- 每个 Item 保存 output、Trace、Scores；
- 多次重复运行和方差；
- 两两比较与回归阈值；
- CI 中失败即阻止发布。

当前 Benchmark 的任务 `projectFixture` 字段尚未真正驱动隔离环境，Runtime Executor
仍可能使用当前工作区；这会削弱可复现性。

### 2.4 第三优先缺口：在线评测与人工评测

在线评测规则应支持：

- 按 project / model / user / tag / observation type 过滤；
- 按比例采样；
- 一条规则触发多个 Evaluator；
- 对历史数据回填；
- 记录 Evaluator 版本、输入映射、成本和失败原因。

人工评测应支持：

- Score Config；
- Annotation Queue；
- 审核人分配；
- 人工评分、评论与 corrected output；
- 人工分数和 LLM Judge 的一致性分析。

## 3. 长任务可靠性当前实现

### 3.1 超时

| 层级 | 当前实现 | 评价 |
| --- | --- | --- |
| LLM 调用 | `RoundExecutor` 默认 60s；provider/model 可覆盖；timeout 与 caller abort 分流 | 较完整 |
| CLI 工具 | 默认 60s，缺失工具自动安装后的重试默认 30s | 基本可用 |
| `shell.run` | 默认 120s，限制 1s–600s；`execFile` timeout 终止进程 | 基本可用 |
| 人工审批 | 默认 300s；未响应 fail-closed 为 `cancelled` | 符合安全原则 |
| Eval Task | 可配置 `timeoutMs`，但默认未启用；超时只 reject Promise | 不完整 |
| Goal / Task 总 deadline | GoalContract 有 `timeoutMs` 类型，但执行层未读取和落实 | 缺失 |
| HTTP 长请求 | API 持有请求直到 Goal 完成 | 不适合真正的长任务 |

模型超时最终在 Provider 层是 `timeout`，但 Task 主循环通常将其视为
`driver-error`；`TaskStopReason` 也没有 `timeout`。因此端到端审计中会保留
attempt timeout 事实，但 Task 终态无法直接表达 timeout。

Eval 的 `withTimeout()` 没有 AbortSignal。超时后报告已结束，底层 Runtime 仍可能继续
执行并产生副作用。这是评测可靠性中的高优先级缺陷。

### 3.2 取消

当前取消主链路：

```text
POST /api/sessions/:id/stop
  → HarnessRuntime.stopGoalTree()
  → AbortController.abort()
  → runGoalTree(signal)
  → executeTask(signal)
  → LLM request signal
```

已实现：

- 模型轮次可以真正 abort；
- caller abort 不重试、不计 Provider 错误率；
- Task 置 `aborted`，Goal 保持可恢复；
- 空闲时再次 stop 返回 `idle`，接口幂等；
- 已完成 Step 保留，未开始 invocation 保留 `pending`；
- 未开始的工具调用在恢复时执行。

缺口：

- 运行中的工具调用不会收到 `AbortSignal`，停止只在下一个工具边界生效；
- 等待人工审批时也未被 stop 立即取消，审批仍可能等到响应或 TTL；
- 进程崩溃时没有持久化“取消意图”，最终状态依赖执行线程回写；
- 只有 `user-stop` 主因，缺少 shutdown、budget、deadline、parent-cancel 等原因矩阵；
- 多进程没有 run owner / lease，无法可靠阻止两个进程操作同一 Goal。

### 3.3 重试

模型调用重试已经策略化：

- `rate_limit`：本地 2 次、指数退避、可 failover；
- `timeout`：本地 1 次、2s 退避、可 failover；
- `network`：本地 2 次、指数退避、可 failover；
- `aborted`、`invalid_request`：不重试；
- 整轮 `maxAttempts` 默认 4；
- 端点熔断器支持 closed/open/half-open；
- 记录 attempts、errorCode、delay 和健康影响。

缺口：

- 实际退避没有 jitter，存在并发重试雪崩风险；
- Tool 没有统一的 retry policy / retry budget；
- 工具错误通常标为 `retryable:false`，是否重试主要依赖模型再次提议；
- 没有按副作用类型区分可重试与不可重试；
- 没有持久化 retry task / delayed retry queue；
- 没有全局 deadline 下的“剩余重试预算”计算。

### 3.4 中断恢复

当前恢复模型：

```text
Goal(active|aborted)
  → 复用持久化 Task(taskId 不变)
  → 读取历史 Step
  → 重放到 ContextManager
  → 补执行 pending invocation
  → 从下一模型轮继续
```

已实现：

- 手工 `POST /api/sessions/:id/resume`；
- Task ID 不重建，历史 Step 不覆盖；
- 成功工具调用可从历史恢复结果；
- 同 Task 内成功调用可按 `tool + JSON(arguments)` 去重；
- 模型中断时 checkpoint 为上一完整轮；
- 工具中断时未开始的调用保持 pending。

缺口：

- 不做进程崩溃后的自动恢复；
- 运行租约、heartbeat、fencing token 缺失；
- `active` invocation 代表“已开始但结果未知”；恢复时会重新执行，若副作用已发生但
  output 未落库，可能重复；
- create → execute 之间的 model、PromptPack、skills、allowedTools、planProposal
  等运行选项主要保存在进程内 Map；进程重启后会丢失；
- toolset snapshot digest 有审计记录，但恢复不自动重新校验“工具定义是否变化”；
- 没有 poison-task / dead-letter / 人工介入恢复队列。

### 3.5 幂等

当前的幂等是**局部、尽力而为**：

- Task 内成功 Tool 调用以 `toolName + JSON(arguments)` 缓存结果；
- 恢复时从成功 Step 重建缓存，避免同 Task 重复成功调用；
- 失败调用不缓存，允许再次尝试；
- AB 实验重复 execute 时只运行 pending arms；
- stop 空闲时幂等；
- 事件总线以 eventId / hash chain 提供审计事实去重基础；
- 文件副作用有 effect journal 和逆序回滚。

关键缺口：

1. Tool key 不是规范化参数摘要，object key 顺序不同可能产生不同 key；
2. key 未包含 rootGoal/task/toolset/policy 版本，不能作为跨 Task 的业务幂等键；
3. `active` 调用结果不确定时没有 reconciliation，只能重跑；
4. 文件快照在工具执行后才写 effect journal：

   ```text
   snapshotFiles()
   → execute tool
   → effectStore.append()
   ```

   若进程在 execute 后、append 前崩溃，则实际副作用已发生但没有可回滚记录。
5. `shell.run`、`git` 和远程工具不自动回滚，也没有 provider 级 idempotency key；
6. HTTP POST 没有 `Idempotency-Key`、请求账本或相同响应重放；
7. 多进程没有 fencing，两个 runner 可能同时执行同一 Task。

因此当前最多是“同进程/同 Task 成功调用的去重”，不是业界意义上的 effectively-once。

## 4. 业界标准

### 4.1 Deadline 与 Timeout

业界 durable workflow / job system 通常采用：

1. **端到端 deadline**：请求携带绝对 deadline，所有模型、工具、审批和重试使用剩余时间。
2. **分层超时**：connect/read/idle/total 分开；Task 和 Goal 也有总预算。
3. **超时可分类**：timeout 是可观测终态或可重试原因，不被折叠成 driver-error。
4. **真正取消底层工作**：超时必须触发 AbortSignal / process kill，不能只让上层 Promise 返回。
5. **fail-closed**：审批、授权和需要人工确认的动作超时默认拒绝。

mazi 目标：

- 将 GoalContract `timeoutMs` 落实为运行 deadline；
- 向 RoundExecutor、ToolGateway、ApprovalBroker、Verifier 统一传递剩余时间；
- 增加 Goal/Task/Step 的 timeout 终态和 failure category；
- Eval timeout 必须中止 Runtime。

### 4.2 Cancellation

标准模式：

- 单一 cancellation tree，父任务取消自动传播子任务；
- 区分 user cancel / deadline / shutdown / budget / parent cancel；
- 取消请求幂等并持久化；
- 停止接收新工作，允许有限 grace period；
- 运行中工具收到 signal；超时后强杀可终止的进程；
- 等待 in-flight side effect 得到明确结果或进入 reconciliation；
- 取消后不进入普通 retry。

mazi 目标：

- ToolGateway 的 `invoke()` 增加 signal；
- ApprovalBroker 支持 cancel；
- shell/CLI child process 支持 signal kill；
- 持久化 cancel intent 和 cause；
- 引入 run lease + heartbeat。

### 4.3 Retry

标准模式：

- 只重试 transient 且 retry-safe 的错误；
- 指数退避 + jitter；
- 遵守 `Retry-After`；
- 有 attempt、时间、成本和错误预算；
- 不重试 auth/invalid request/cancel；
- 有副作用调用必须携带 operation/idempotency key；
- 达到上限进入 dead-letter 或人工恢复，不无限重试。

mazi 模型调用已接近该标准；Tool 和 API 层仍需补策略。

### 4.4 Resume / Durable Execution

标准模式：

- 持久化 workflow state 和 event history；
- checkpoint 原子提交；
- worker 通过 lease、heartbeat、 fencing token 独占执行；
- 进程崩溃后其他 worker 可从最后 committed checkpoint 接管；
- in-flight 副作用通过 operation ledger 分类为 committed / not committed / ambiguous；
- ambiguous 操作先 reconciliation，不能直接重放；
- workflow、activity 和 tool 版本参与恢复兼容性检查。

mazi 已有良好的 Step checkpoint 基础，但还缺少自动 takeover、lease/fencing、
ambiguous-effect reconciliation 和版本兼容门禁。

### 4.5 Idempotency

标准目标不是字面 exactly-once，而是：

> at-least-once delivery + idempotent execution / durable deduplication = effectively-once

常用实现：

- HTTP `Idempotency-Key`；
- operation ledger：`idempotency_key + scope + request_hash + status + result_ref`；
- 先写 intent / reservation，再执行副作用，最后 commit；
- 使用 transactional outbox 发送外部消息；
- 工具声明 `idempotent`、`max_attempts`、`idempotency_scope`；
- 结果缓存和 key TTL；
- 对不可幂等工具强制人工审批且不自动 retry。

### 4.6 长任务 HTTP 模式

不要在 HTTP 请求生命周期内等待完整长任务。标准模式是：

```text
POST /runs + Idempotency-Key
  → 202 { runId }
  → GET /runs/:id
  → SSE / WebSocket 进度
  → POST /runs/:id/cancel
```

当前 mazi 的 `/run` 和 `/resume` 会在请求内 await 全任务完成，适合短会话和本地桌面，
不适合数分钟到数小时的任务、移动网络和网关超时环境。

## 5. 建议实施顺序

### P0：修复正确性风险

1. `feat(runtime): persist run execution envelope and restore options`
2. `feat(runtime): enforce goal and task deadlines end to end`
3. `feat(runtime): propagate cancellation into tools and approvals`
4. `feat(effects): persist effect intent before side effects`
5. `feat(api): add Idempotency-Key and request deduplication ledger`
6. `fix(eval): abort runtime when evaluation task times out`

### P1：形成可恢复长任务

7. `feat(runtime): add run leases heartbeats and fencing`
8. `feat(runtime): reconcile ambiguous in-flight tool effects`
9. `feat(api): expose asynchronous run submission and status`
10. `feat(tools): add retry policy and idempotency declarations`
11. `feat(runtime): add dead-letter and operator recovery flow`

### P2：评测平台补齐

12. 通用 Score / Score Config；
13. 动态 Dataset 与 production-to-dataset；
14. 可配置 Evaluator 与在线规则；
15. Dataset-backed Experiment 与 CI 回归；
16. Annotation Queue、Score Analytics 和告警。

## 6. 目标验收门禁

| # | 门禁 |
| --- | --- |
| LR-1 | 同一 Goal 在进程任意位置崩溃后，重启可从 committed checkpoint 恢复 |
| LR-2 | 两个 worker 不能同时执行同一 Goal；旧 lease 的写入被 fencing 拒绝 |
| LR-3 | 同一 HTTP 请求携带相同 Idempotency-Key 只创建/执行一次 |
| LR-4 | 同一 logical tool call 重放不会产生第二次外部副作用 |
| LR-5 | 进程在“副作用已发生、结果未落库”间崩溃时，系统进入 ambiguous 而非盲目重跑 |
| LR-6 | user cancel、deadline、shutdown、budget 有不同 durable cause 和终态 |
| LR-7 | 运行中工具和审批可被取消；进程型工具在 grace period 后强制终止 |
| LR-8 | 所有 retry 受总 deadline 和总 attempt budget 约束，并带 jitter |
| LR-9 | 恢复时校验 model、PromptPack、toolset、policy 和 schema version |
| LR-10 | Eval timeout 后底层 Runtime 不再继续执行或产生副作用 |

## 7. 官方参考

- [Langfuse Evaluation Overview](https://langfuse.com/docs/evaluation/overview)
- [Langfuse Evaluation Core Concepts](https://langfuse.com/docs/evaluation/core-concepts)
- [Langfuse Scores](https://langfuse.com/docs/evaluation/scores/overview)
- [Langfuse Datasets](https://langfuse.com/docs/evaluation/experiments/datasets)
- [Langfuse Annotation Queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues)
- [Langfuse Code Evaluators](https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators)
- [Langfuse Prompt Management](https://langfuse.com/docs/prompt-management/overview)

## 8. 代码索引

- Provider 超时/重试：`packages/runtime/src/provider/orchestrator.ts`
- Retry Policy / Circuit Breaker：`packages/runtime/src/provider/retry.ts`
- Task 执行和 pending invocation：`packages/runtime/src/gts/goal-executor.ts`
- Goal/Task 恢复：`packages/runtime/src/strategy/goal-strategy.ts`
- Run 取消/恢复：`packages/runtime/src/harness/runtime.ts`
- 工具进程超时：`packages/runtime/src/harness/tool-executor.ts`
- 审批 TTL：`packages/runtime/src/tool-gateway/approval.ts`
- 副作用 journal：`packages/runtime/src/effects/effect-store.ts`
- HTTP 控制面：`apps/api/src/sessions/sessions.controller.ts`
- Eval 超时：`packages/runtime/src/eval/runner.ts`
