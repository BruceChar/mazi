# 统一执行主干：Router → Plan → Replan

本文定义 Goal 级唯一编排主干。目标是消掉 `goal-parser`、SuperAgent Router、run 前 Plan 三套
互相重叠的判定，把「问题是什么、要不要展开计划、要不要协商、失败后怎么重规划」全部收进
`WorkflowRunner` 的节点序列。

## 一、唯一主干

```text
router ──direct───────────────────────────────> terminal(done, finalAnswer)
   │
   └──workflow──> plan ──negotiate?──> negotiate ─> terminal(awaiting-negotiation)
                    │
                    ├──planned──> think ─> act ─> observe ─> think
                    │                └──────> verify ─> think
                    │                              └──failed──> replan ─> think
                    └──rejected──> terminal(failed)
```

- `router`、`plan`、`replan`、`negotiate` 都是 `WorkflowRunner` 的正式节点，不是 run 前的
  旁路步骤；一次 run 的 Trace 必须能按节点顺序看到它们。
- 是否展开多 Task 由 `router` 的问题判定和 `plan` 的实际产出决定，**不再由“随心聊 / project”
  会话类型决定**。
- `default` / `dynamic` 不再作为产品分支。`loopMode` 只保留为迁移期的 A/B 自变量；主路径
  只有一个节点编排。`resume` 在迁移完成前仍走旧串行路径，因其只承载历史 Task 重放。
- `executeTask` 内部的 Task 级 runner 只跑 `think/act/observe`，不得再创建 `router/plan/
  replan` 节点。Goal 级编排只在最外层发生一次。

## 二、职责边界

| 组件 | 只负责 | 明确不负责 |
| --- | --- | --- |
| `goal-parser` | 把自然语言解析成结构化意图：目标、约束、问题类型、难度、是否需要展开计划、直答内容、协商问题 | 不决定 workflow 走哪条边、不执行、不写最终 Task 图 |
| `Router` 节点 | 统一入口：消费解析结果与运行环境，产出 `problemType / difficulty / needsPlan / risk / promptPack / memoryPlan`；直答则终止 | 不生成 Task、不决定契约条款、不调用工具 |
| `Plan` 节点 | 决定是否协商；应用契约增量；在 `needsPlan` 时生成 Task 图，否则生成单 Task；落库并广播计划 | 不执行 Task、不重试、不做失败归因 |
| `Replan` 节点 | 在本次 run 内修订计划：保留未执行 Task，只补补救 Task，升 `planVersion` | 不新开 Goal、不跨 run 改写历史 |
| `Negotiate` 节点 | 把 Plan 的协商决定变成可等待的用户输入：落 `blocked`、发 `goal.negotiation.requested`、终止本次 run | 不生成默认路径之外的 Task |
| `WorkflowRunner` | 选节点、校验转移、计步、终止、事件、resume/replan/memory 能力挂载点 | 不解析自然语言、不拼 prompt、不执行工具 |
| `TaskExecutionContext` | 单 Task 的上下文、Step、工具缓存、成本、单步效果 | 不选 Task、不规划、不重规划 |

### Router 与 goal-parser 的关系

`goal-parser` 是 Router 的语义解析器，不是第二个 Router。Router 不再用关键词重新分类；
它读取 `ParsedGoalPlan.trace` 的 `classification / taskType / difficulty / needsPlan`，缺省时才
用请求语句做保守回退。`classifyTaskKind` 只作为无模型或解析失败时的兜底，不再以工具可用性
推断任务类型。

### Plan 与 goal-parser 的关系

Plan 是契约协商的**决定者**。`goal-parser` 只提供 `route / questions / constraints / answer`
候选；Plan 在生成 Task 前决定：

1. `direct`：不进入 Plan，Router 已终止；
2. `confirmed`：应用增量条款，继续规划；
3. `negotiate / escalate`：应用已解析条款并发出 `goal.negotiation.requested`。产品默认仍按
   `defaultPath` 执行，协商是“可答复的修订机会”，不吞掉本轮输入；若宿主显式选择暂停，Plan
   才返回 `next: negotiate`，由 `negotiate` 节点终止本次 run；
4. 解析缺失或模型失败：走默认路径，不伪造协商。

因此 triage 不能在 `SessionFactory.create()` 里提前把协商请求发出去；创建只冻结基线契约，
解析结果作为本轮输入交给 Router/Plan。

## 三、状态与转移

### Phase

```ts
type Phase =
    | 'router'
    | 'plan'
    | 'negotiate'
    | 'think'
    | 'act'
    | 'observe'
    | 'verify'
    | 'replan'
    | 'reflect';
```

`reflect` 只做失败诊断，不直接改计划；它把 `replanRequested` 置真并转到 `replan`。没有注入
`ReplanPlanner` 时，`verify` 的失败直接终止，不进入 `replan`。

### 合法转移

```text
router    → plan | (terminal direct)
plan      → think | negotiate | (terminal rejected)
negotiate → (terminal awaiting-negotiation)
think     → act | plan | verify | replan
act       → observe
observe   → think | verify | reflect
verify    → think | reflect | replan
reflect   → replan | think
replan    → think | plan
```

### RunState 增量

`RunState` 仍是可持久化事实；本轮新增的编排事实必须可重建：

| 字段 | 含义 | 谁写 |
| --- | --- | --- |
| `router` | 问题类型、难度、`needsPlan`、路由原因 | Router |
| `negotiation` | 本轮协商路线与问题摘要 | Plan |
| `awaitingNegotiation` | 已终止等待用户答复 | Negotiate |
| `replanRequested` | 需要进入 `replan` 节点 | Verify/Reflect |
| `finalAnswer` | direct 路线回答；无 Task 承载 | Router |

`WorkflowState.phase` 如旧，只表示“本步要执行的节点”。首步不由 runner 硬编码 `think`，而是
读取初始 `phase`；统一编排从 `router` 开始，Task 级执行仍从 `think` 开始。

### 终态

`Outcome` 增加 `awaiting-negotiation`。它表示“本轮已安全停止，等待用户答复”，不是失败：

- Goal 保持 `blocked`，不写 `succeeded/failed`；
- 用户答复后 `negotiateGoal` 修订契约；下一次 run 继续沿统一编排执行；
- `negotiation` 节点本身不生成 Task，因此不存在半执行计划；
- 若 Plan 选择默认路径继续，则本轮正常生成 Task 并执行，协商请求只作为可答复的修订入口。

## 四、能力挂载点

能力统一签到 `WorkflowRunner`，不在各 loop 里复制：

| 能力 | 挂载方式 |
| --- | --- |
| Router | `WorkflowHost.router`；缺失时不创建节点，直接从 `plan` 开始（兼容 Task 级 runner） |
| Plan | `WorkflowHost.plan`；生成、校验、落库、`plan.created` 都在这里 |
| Replan | `WorkflowHost.replan` + `GoalRunDeps.replan`；节点只调用统一 replan 服务 |
| Negotiation | `WorkflowHost.negotiate`；只负责落 `blocked` 与终止 |
| Resume | `GoalRunDeps.resume`；从 `GoalStore` 重建执行态，Task 内用 `resumeSteps` 重放 |
| Memory | `GoalRunDeps.memory`；Goal 级 `think` 前召回，`verify` 后写回，Task 级只消费注入的贡献 |
| 事件 | `WorkflowRunner` 的 `node.selected / node.failed / workflow.terminated`；Router/Plan 不再绕过 runner 另发节点事件 |

Task 级 runner 只注册 `think/act/observe`；它不感知 Router/Plan/Replan，避免每个 Task 重复路由
和规划。

## 五、迁移顺序

1. **契约**：扩 `Phase / RunState / Outcome / TRANSITIONS`，补 Router/Plan/Replan/Negotiate 节点工厂测试。
2. **编排**：`dynamic-loop` 支持可选的 `orchestration`，把 run 前 plan 移入 `plan` 节点；补 resume、replan、memory。
3. **入口**：`TurnEngine` 非 resume 一律走统一编排；Router/Plan 从 `SessionFactory` 接过解析结果，删掉 `chatMode` 对 `parseIntent/taskPlanning` 的门控。
4. **收口**：`default` 串行路径冻结为 resume-only legacy；等 resume 迁移完成后再删除，不在本阶段直接删代码。

每一步都必须先有对应测试；`plan.created` 的时序从“run 前”改为“plan 节点执行时”，UI 以事件
为准，不依赖固定前置阶段。
