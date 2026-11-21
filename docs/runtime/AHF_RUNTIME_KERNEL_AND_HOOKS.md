# Runtime Kernel 与 Hook 契约

> 状态：设计定稿，按 §8 分批实现
> 范围：`packages/core`（坐标与钩子契约）、`packages/runtime`（`hooks/`、`kernel/`、装配点）、`apps/api`（会话边界与组合根）
> 依据：`wiki/overview/architecture.md`、`docs/能力包规范.md`、Codex（SQ/EQ + Thread/Turn/Item + hooks）、DeepSeek Harness（Cordis 插件事件 + 五种派发）、Claude Code hooks（session/turn/tool 三层节奏）

---

## 1. 问题

系统已有事件总线（`emit` 只追加、可回放、哈希链），但没有：

1. **会话/轮次坐标**：`rootGoalId` 是一次用户消息，真正的会话是 `conversationId`，而它只存在于 API 层的 `conversations.json`。事件按 `rootGoalId` 分片，`session.started` 发生时还没有"属于哪个会话"的归属信息。
2. **控制面**：只有单向广播。外部扩展（记忆、评估、策略）只能"事后看"，不能"事中改/拦"。
3. **装配面**：`HarnessRuntime` 是一个 2600+ 行的类，扩展靠 `attachSkills` / `setCatalog` 手工挂载；插件无法替换能力，只能旁挂。

因此本设计把**事实（event）**、**控制（hook）**、**装配（kernel）**拆成三个互不越界的面，并先补齐坐标。

---

## 2. 五层地基

| 层 | 职责 | 本设计的落点 |
| --- | --- | --- |
| 1 坐标与状态机 | Goal/Task/Step + Session/Turn | `TraceIdentifiers.sessionId`、`turn.*` 事件 |
| 2 能力面 | tool registry / provider / skill / blackbox | `RuntimeKernel` 注册为服务（渐进迁移） |
| 3 治理面 | 权限、审批、预算、沙箱 | 不变；hook 不得改写 `permissionCeiling` / `budget` |
| 4 观测面 | append-only 事件流、usage、SSE | 扩展：`sessionId` 归因 + session 事件流 |
| 5 扩展面 | hook 闭集 + plugin host | 本期：`hooks/` + `kernel/`；plugin 宿主后续 |

三条不变量：

- **事件只追加、只通知**，永不承载控制决策；
- **钩子只做决策与改写**，每次调用必须落一条审计事件；
- **装配可逆**，任何注册都返回撤销函数，`dispose()` 逆序回收。

---

## 3. 坐标

### 3.1 Session / Turn

- **Session** = `conversationId`（跨多条用户消息的持久会话）。
- **Turn** = 一次 `createGoalSession` → `executeGoalTree`（`rootGoalId` 即 turn 标识）。
- `HarnessEvent.sessionId?: string`；`TraceIdentifiers` 同步增加可选 `sessionId`。
- 由 `DefaultEventBus` 的 `sessionOf(rootGoalId)` 解析器统一补全，**34 处 emit 调用点零改动**；事件自带的 `sessionId` 优先，不被覆盖。

### 3.2 事件流分片

执行事件仍按 `rootGoalId` 分片（`<rootGoalId>.jsonl`）。会话级事件（`session.started` / `session.ended`）使用**会话锚点**：

```
sessionStreamId(sessionId) = "session-" + sessionId
```

会话级事件以锚点作为 `rootGoalId`，落在同目录的 `session-<id>.jsonl`，从而：

- 通过既有 `validateTraceIds` / 哈希链 / `verifyChain`，不引入第二条持久化实现；
- `replaySession(sessionId)` 先读锚点文件，再扫描其余文件按 `sessionId` 过滤并排序，得到"该会话全部事实"。

### 3.3 生命周期事件（闭集）

| 事件 | 级别 | 锚点 | 触发点 |
| --- | --- | --- | --- |
| `session.started` | info | 会话锚点 | 会话首轮 `createGoalSession`（进程内幂等） |
| `session.ended` | info | 会话锚点 | `endSession()`（会话删除/归档/显式收尾） |
| `turn.started` | info | `rootGoalId` | `executeGoalTree` 读取完 Goal 之后 |
| `turn.ended` | info | `rootGoalId` | 执行返回或抛错之后 |
| `hook.invoked` / `hook.decided` / `hook.patch` / `hook.failed` / `hook.timed_out` | debug~warn | 随 hook | 每次有实际监听器参与的调用 |

`turn.ended` 必须携带 `ok`、`reason`、`tasks` 计数，供监控与评估消费。

---

## 4. 钩子

### 4.1 闭集

```
session.start      session.end
turn.start         turn.end
context.assemble   compaction.pre
tool.pre           tool.post
llm.pre            llm.post
```

新增点属于**契约变更**，必须同步修订本文与测试。本期**已接线**：`session.start/end`、`turn.start/end`、`tool.pre/post`；`context.assemble`、`compaction.pre`、`llm.pre/post` 只保留契约与派发能力，接线留待后续（不得在文档中宣称已生效）。

### 4.2 五种派发语义

| 模式 | 语义 | 默认用于 |
| --- | --- | --- |
| `emit` | 同步广播，不收集返回值 | `llm.pre/post` 类纯观察 |
| `parallel` | 并发等待全部，错误隔离 | `session.end` / `turn.end` 类副作用 |
| `serial` | 按序等待，收集全部结果 | 需要顺序的外部调用 |
| `bail` | 按序求值，首个 `block` 胜出并停止；`patch` 累积 | `tool.pre`（首个拦截生效） |
| `waterfall` | 链式改写，可短路 | `turn.start` / `context.assemble` / `tool.post` |

### 4.3 决策

```ts
type HookDecision =
    | { kind: 'continue' }
    | { kind: 'block'; reason: string }
    | { kind: 'patch'; patch: Record<string, unknown>; reason?: string };
```

- `block` 只对 pre 类点生效；`post` 类忽略 `block`（降级为 `continue` 并记 `hook.decided`）。
- `patch` 只允许白名单字段（如 `tool.pre` 的 `arguments`、`tool.post` 的 `content`、`turn.start` 的 `contextAppend`），未知字段丢弃并告警。
- **hook 不得返回权限/预算相关的 patch**；治理面只接受人工审批。

### 4.4 执行约束

- 每个 handler 有 `timeoutMs`（缺省 2000ms；`session.end` / `turn.end` 缺省 5000ms）。
- 超时或异常默认**隔离**（记 `hook.failed` / `hook.timed_out`，继续执行）；仅 `onError: 'fail'` 的 handler 在 pre 点转为 `block`（fail-closed）。
- `turn.end` / `session.end` 的 hook 由宿主异步队列执行，**不进主循环**；同步点只有 `turn.start`、`tool.pre`、`tool.post`、`context.assemble`。
- 审计事件只在"有监听器实际参与"时发出，避免空 hook 造成事件噪声；`turn.ended` / `session.*` 无论有无 hook 都发。

### 4.5 主循环延迟预算

| 点 | 同步 | 硬上限 |
| --- | --- | --- |
| `turn.start` | 是 | 2s |
| `tool.pre` | 是 | 1s |
| `tool.post` | 是 | 1s |
| `turn.end` / `session.end` | 否（队列） | 5s |

---

## 5. RuntimeKernel

最小装配容器，不做完整 DI：

```ts
kernel.provide('eventBus', () => bus);
kernel.provide('hooks', () => hooks, { requires: ['eventBus'] });
kernel.provide('tools', () => registry, { requires: ['eventBus'] });
kernel.start();
```

- 服务状态机：`pending → loading → active → disposed`；`get()` 只返回 `active` 服务，否则抛带缺失链的错误。
- 依赖按 `requires` 做拓扑实例化；缺失依赖或环依赖在 `start()` 阶段 fail-fast。
- `effect(dispose)` 注册可逆副作用，`dispose()` 按注册逆序执行，单个失败不影响其余（错误回报 `onError`）。
- **不追求**替换 core loop：本期只把既有服务登记进 kernel，`HarnessRuntime` 仍是编排者；插件可替换"能力服务"，不可替换"治理服务"。

---

## 6. 挂载点映射

| 诉求 | 挂载面 | 同步/异步 | 可否阻断 |
| --- | --- | --- | --- |
| 监控、审计、计费、轨迹 | event 流 | 异步、可丢 | 否 |
| 记忆召回 | `session.start` / `turn.start` | 同步、硬超时 | 否（只改注入） |
| 记忆抽取、评估、wiki 同步 | `turn.end` / `session.end` | 异步队列 | 否 |
| 危险命令拦截 | `tool.pre` | 同步 | 是（fail-closed） |
| 工具结果裁剪/脱敏 | `tool.post` | 同步 | 否（改写） |
| 上下文注入/压缩 | `context.assemble` / `compaction.pre` | 同步 | 否（改写） |
| 新工具/新 provider/新存储 | `RuntimeKernel` 服务 | — | 走权限天花板 |

---

## 7. 迁移路径

1. **本期**：坐标、事件类型、`hooks/`、`kernel/`、`session/turn/tool` 接线、`HarnessRuntime` 拆薄（`SessionIntake` + `hooks/lifecycle` + `events/emitters`）。
2. **下一步**：`plugins/`（manifest、加载、健康）与 `context.assemble` / `llm.pre/post` 接线。
3. **之后**：把 `apps/api` 里硬编码的 `recordEvaluation` / `scheduleProjectWikiSessionSync` 迁为内置插件，双跑一期后删除硬编码。

兼容约束：

- `DefaultEventBus` 新选项与 `replaySession` 均为**增量**，既有签名不变；
- 事件 `rootGoalId` 必填规则不变；
- `packages/core` 不新增实现依赖。

---

## 8. 非目标与风险

- 不做 DSL / 脚本钩子：外部命令式 hook（Claude Code 风格）放到 plugins 期，且必须是"不可逆副作用 + 补偿"，不得阻塞主循环。
- 不让 hook 参与权限判定；不得引入"hook 返回允许即放行"的路径。
- 不做全量 DI 重写：`HarnessRuntime` 只做**渐进登记 + 局部抽出**，避免一次性重构带来的回归面。
- 风险：`session.end` 语义依赖宿主显式调用；空闲超时本期不实现（由 API 层后续接入）。

---

## 9. 验收

- 坐标：同一会话的所有执行事件都带 `sessionId`；`replaySession` 能取回 session/turn 全链。
- 钩子：五种派发各自有单测；超时、异常、fail-closed、priority 顺序、patch 白名单有回归。
- 装配：依赖顺序、缺失依赖、环依赖、逆序 dispose、effect 撤销有单测。
- 回归：全量 `pnpm test` 通过；`pnpm lint` 无新增问题。
