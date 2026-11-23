# Runtime Faults 契约（错误层）

> 状态：设计定稿，按 §9 分批实现
> 范围：`packages/runtime`（`faults/`、工具调用接线、执行循环失败口径）；`packages/core` 只保留 `fault.raised` / `fault.recovered` 观测事件
> 分层：Fault 属**运行时业务层**，不进 core 契约——core 不得定义错误域枚举
> 关系：与 `docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md` 平行——**hooks 管"事中改写"，faults 管"事后处置"**，两者互不合并
> 依据：现有分散实现（`provider/retry.ts`、`core/authz/gateway.ts`、`gts/goal-executor.ts`、`hooks/runner.ts`、`memory/failure-ledger.ts`）

---

## 1. 问题

错误处置现在散在五处，各自一套口径：

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `provider/retry.ts` + `provider/orchestrator.ts` | 错误码策略表、退避、熔断、健康分、超时信号 | 只有"模型调用"享有完整策略 |
| `core/authz/gateway.ts` | 缺参 `INVALID_ARGS`、抛错兜成 `EXECUTION_FAILED` | 分类在出口被压平成字符串，下游不可用 |
| `gts/goal-executor.ts` | 循环内任何抛出 → `driver-error`，Task 直接 `failed` | 工具抖动等于整树失败 |
| `hooks/runner.ts` | 吞掉钩子异常，只发 `hook.failed` | 无处置决策、无升级 |
| `verifier/` | 验收失败走 replan | 正常分支，不进失败账 |

结果：同一类失败在不同位置的处置不同；"这次失败谁处理了、为什么不再重试"没有单一答案。

本设计引入**一个错误处置层**：任何来源的失败先归一化成 `Fault`，再由策略表决定恢复动作，最后只在一处留痕。

---

## 2. 三层职责

| 层 | 只有它能做的事 | 绝不做 |
| --- | --- | --- |
| 生产者（tool / provider / hook / verifier / storage） | 判定失败**性质**：`domain` + `kind` + `retryable` + `hint` + `fix` | 不重试、不 sleep、不熔断、不改上下文 |
| 错误层（`faults/`） | 归一化、按策略表决策、尝试计数、退避、作用域升级、发事件/入账 | 不实现工具、不生成用户文案、不改治理判定 |
| 消费者（模型 / 上层编排） | 读观察改参数或换工具；按升级结果重规划或中止 | 不决定重试次数 |

判据：**生产者知道"错在什么性质"，但不知道"已经错过几次"**——跨轮次记忆只存在于错误层。

---

## 3. Fault 契约

Fault 定义在 `packages/runtime/src/faults/types.ts`（**不是 core**）：core 是 AHF 契约层，
不承载业务角色词汇；新增 `planner` / `verifier` / 任何后续角色都不应触发 core 变更。

```ts
interface Fault {
    faultId: string;
    domain: string;             // 域由产出方声明（'provider' | 'tool' | 'billing' | 未来任意）
    kind: string;               // 处置分类同样开放；runtime 只内置一组默认策略键
    severity: FaultSeverity;    // recoverable | degradable | fatal
    scope: FaultScope;          // call | turn | task | goal | session
    retryable: boolean;         // 生产者的判断，不是策略
    idempotent?: boolean;       // 决定"超时能否重试"的前提
    key?: string;               // 尝试计数键（同参调用必须一致）
    code?: string;              // 厂商/网关原始码，保留可追溯
    message: string;
    hint?: string;              // 回给模型的处置建议
    fix?: { missing?: string[]; expected?: string; got?: string };
    identifiers?: TraceIdentifiers;
    cause?: unknown;
}
```

三条约定：

- **domain / kind 是开放字符串**：产出方自己声明常量（如 `tool-invoker` 的 `TIMEOUT`、
  provider 错误码映射），错误层不维护闭集；新增业务角色只在自己的包里加常量；
- `severity` 由生产者给，错误层不得提升或降低；
- `key` 缺省由调用方按 `domain:tool:JSON(arguments)` 生成，**同参必须同键**；
- `retryable` 与策略表冲突时以策略表为准，冲突本身记一条 `fault.raised`。

---

## 4. 恢复阶梯

错误在**能吸收它的最小作用域**处理；向上只升级一次，不复制一份处理。

| 级别 | 动作 | 典型 kind | 生效作用域 |
| --- | --- | --- | --- |
| L0 | `retry`：同参重试 | `timeout`（幂等）、`transient` | call |
| L1 | `retry_altered`：变参/换工具/换模型 | `invalid_args`（交模型改参）、`not_found` | call / turn |
| L2 | `degrade`：部分结果收尾、跳过非关键子任务 | `internal`（非幂等）、`hook` 失败 | task |
| L3 | `escalate`：重规划 / 换执行策略 | `verifier` 验收失败、`planner` 不可行 | task → goal |
| L4 | `abort`：预算耗尽、`fatal`、权限硬失败 | `budget_exhausted`、`fatal`、`policy_denied` | goal / session |

不变量：

- **升级只发生一次**：L2 处置后上层只看到"已降级 + reason"，不再看到原始错误副本；
- **`fatal` 永不吞**：`severity: 'fatal'` 直接 abort，不重试、不降级，附完整上下文；
- **非幂等不盲目重试**：带副作用的工具未声明 `idempotent` 时，`timeout` 也只降级不重试。

---

## 5. 默认策略表

按 `kind` 给基线，`domain` 可覆盖（写法对齐 `provider/retry.ts` 的可替换表）。
表键是**内置默认**而非闭集：未登记的新 kind 落到 `unknown` 兜底策略，无需改本表即可上线。

| kind | action | maxAttempts | backoff | 出口 |
| --- | --- | --- | --- | --- |
| `timeout` | `retry` | 1（需幂等） | none | 超限 → `degrade` |
| `transient` | `retry` | 2 | exponential（100ms 基数） | 超限 → `escalate` turn |
| `invalid_args` | `retry_altered` | 0 | none | 回 `fix` 给模型 |
| `not_found` | `retry_altered` | 0 | none | 回近似候选给模型 |
| `policy_denied` | `abort` | 0 | none | 交宿主（审批/人工） |
| `internal` | `degrade` | 0（幂等时 1） | none | 观察里标注降级 |
| `budget_exhausted` | `abort` | 0 | none | goal 终止 |
| `fatal` | `abort` | — | — | 立即上报 |
| `unknown` | `degrade` | 0 | none | 保守降级 |

---

## 6. fatal 白名单

`severity: 'fatal'` 只允许这几类，其余一律可恢复/可降级：

- 编程缺陷：`TypeError` / `ReferenceError` 等运行时错误；
- 不变量破坏：上下文哈希不一致、账本条目缺失、事件链断链；
- 装配错误：`RuntimeKernel` 缺依赖/环依赖、权限派生失败；
- 存储损坏：SQLite 打开失败、schema 不兼容。

工具实现抛错**不是** fatal——它属于工具域 `internal`。

---

## 7. 观测

| 产物 | 内容 |
| --- | --- |
| `fault.raised` 事件 | `harness.fault_domain` / `fault_kind` / `fault_severity` / `fault_scope` / `fault_action` / `fault_attempt`，含 `rootGoalId`/`sessionId`/`stepId` 坐标 |
| `fault.recovered` 事件 | 恢复成功时补发，携最终 action 与耗时 |
| 失败分类账 | Task 终态失败仍按 `kind` 入账；`Fault` 只补 `domain`/`code` 归因，不新增表 |
| StepError | 复用 `core/gts.ts` 四源标签，工具失败 `source: 'tool'`，`retryable` 取策略结论而非硬编码 `false` |

---

## 8. 接线点

| 接入点 | 改造 |
| --- | --- |
| `harness/tool-invoker.ts`（新） | `tool.pre` hook → 带 `AbortSignal` + `toolTimeoutMs` 执行 → `tool.post`；抛出全部归一化为 `Fault` 并调用管线；对外承诺**不抛** |
| `core/authz/gateway.ts` | 接受外部 `signal`；`INVALID_ARGS` 保留 `code` 与 `fix`，不再在 runtime 侧压平 |
| `gts/goal-executor.ts` | 工具段不再 try/catch 兜 `driver-error`；`StepError.retryable` 取调用结果 |
| `provider/orchestrator.ts` | 保持现有策略表，改为经 `faults.normalize` 输出 `Fault`，事件口径统一（行为不变） |
| `hooks/runner.ts` | 钩子失败上报到错误层（`domain: 'hook'`），保持 `hook.failed` 审计不变 |

---

## 9. 分步与验收

1. `core/faults.ts`：契约 + 默认策略类型（纯类型 + 表校验测试）。
2. `runtime/faults/`：`normalize` / `policy` / `pipeline`（阶梯、升级一次、fatal 不吞、尝试键记忆）。
3. 工具接线：`ToolInvoker` + gateway `signal` + 执行循环失败口径；测试覆盖"工具超时 → 重试 → 观察"、"参数错 → 0 重试 + fix"、"抛出 → 降级而非 Task 失败"。
4. 观测：`fault.raised` / `fault.recovered` 事件断言。

非目标：不改权限/预算判定；不引入分布式重试；不新增存储表。
