# Workflow 与 Task 执行运行时

本文定义 Task 级执行的唯一控制平面：`WorkflowRunner`。`executeTask` 与 dynamic loop 都
通过它调度节点，不再各自实现循环。

## 一、职责边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `WorkflowRunner` | 选节点、校验转移、计步、超时、无进展终止、发节点事件 | 模型上下文、工具参数 |
| `TaskExecutionContext` | 当前 Task 的上下文、Step、工具缓存、成本累计、单步效果 | `next`、循环、终止、节点选择 |
| `Node` | 调用一次上下文动作，返回 `delta` / `next` / 可选 `terminal` | 持久化调度状态 |

`TaskExecutionContext` 不是 runner。它没有 `while`、没有 phase 游标、不判断完成。

## 二、节点语义

```text
think   一次 LLM 推理，产出 toolCalls 或 final answer
act     执行 think 产出的工具调用，不调用模型
observe 归并上一批工具结果、落 observation Step，回注上下文并判定 continue/final
verify  Task 终态：验收、状态落库
```

合法路径：

```text
think ──toolCalls──> act ──> observe ──> think
think ──final/失败──> verify ──> think | terminal
```

- 默认 loop 的 `executeTask` 只跑一个 Task：`think/act/observe`，最终回答后直接 terminal；
  验收仍由调用它的 `goal-strategy` 负责。
- dynamic loop 在同一个 runner 上跑多 Task，并额外挂 `verify`；`verify` 完成后回到 `think`
  选下一个 Task。
- `think` 只做当前 Task 的推理；选 Task 仍由调度侧确定性完成。
- 一个 `think` 只允许一轮模型调用，一个 `act` 只处理这一轮产出的工具调用。
- `observe` 必须有显式 Step：输入是 Act 产出的 `callId/toolName/status/summary`，输出是
  `disposition=continue|final` 与 `result`；完整工具原文仍留在 invocation Step，二者通过 callId 关联。

### Plan 当前不是 runner 节点

`plan` 不是 `executeTask` / dynamic loop 的 workflow 节点，而是 run 前的规划阶段：

```text
planProposal 缺省
 && 不是 resume
 && taskPlanning（配置了 TaskPlanner 或默认开启）
 && 工具集非空
 && negotiation.route !== 'direct'
```

满足时调用 Task Planner，一次产出 1–6 个 Task；简单目标允许 1 个 Task。模型返回单 Task、
但 Goal 成功条件含至少两个独立产物检查时，会再以 `strictSplit` 重试一次。计划无效或超限时
回退单 Task。也就是说，Plan 的触发不是“复杂度阈值”，而是“非直答且可执行”。

## 三、状态划分

`WorkflowState` 只放可序列化事实：

```ts
plan / facts / pending / acceptance / verdict / failures
currentTaskId?: string
awaitingVerify?: boolean
```

`TaskExecutionContext` 放运行时对象，不进入 `WorkflowState`：

```ts
ContextManager
Step[]
executedCalls 去重缓存
spentUsd
当前 proposal / outputs
```

dynamic 暂不支持 resume，因此进程内上下文无需序列化；默认 loop 仍用已落库 Step 重放。

## 四、终止

`NodeResult.terminal?: Outcome` 让节点显式结束 loop：

- `executeTask`：think/observe 在 final 时返回 `terminal: 'done'`；失败返回 `terminal: 'failed'`。
- dynamic：单 Task 的 verify 只结束当前 Task，不结束整个 run；全部 Task 关闭后由 runner 的
  原有完成判定或显式 terminal 收尾。

`WorkflowRunner` 的 `maxSteps` 是节点保险丝；Task 的 `maxSteps` / `maxCostUsd` 仍由
`TaskExecutionContext` 按模型轮次执行，两者不混用。

## 五、Trace 归属

| 节点 | Step role | agentRole | nodeRunId |
| --- | --- | --- | --- |
| think | `think` | `reasoner` | `think:<taskId>:<round>` |
| act | `act` | `executor` | `act:<taskId>:<round>` |
| observe | `observe` | `observer` | `observe:<taskId>:<round>` |
| verify | `verify` | `verifier` | 由 NodeRun span 记录 |

不再出现 `Thinking` 挂在 `node=act` 的错位。旧 Step 没有 provenance 时按 `kind` 回退。
