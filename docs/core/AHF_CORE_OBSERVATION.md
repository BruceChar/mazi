# AHF_CORE_OBSERVATION

|                    |                                                                                                 |                |                  |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------- | ---------------- |
| **文档版本** | v1.0                                                                                            | **状态** | 定稿（实现依据） |
| **范围**     | 事件信封、因果模型、分区与完整性、事件闭集注册表、观察与装配契约、读写端口                      |                |                  |
| **关联**     | GOAL（归因坐标系）· AUTH（权限）· AUDIT（审计）· TOOL · APPROVAL · PROVIDER（wire 事实层） |                |                  |

> 本文是前两轮裁决的落地稿：第二轮增补的传输不变量（O-新，哈希链）在此正式化为 **O4**；A1 裁决（StepKind 补全 `'action'`）在 step 域事件中体现；A2/A3 不直接涉及本卷。

---

## 0. 总纲

**事件流是 harness 的唯一事实层。** 设计不变量"每一步的判断由模型做出，每一步的事实由 harness 记录"由此承载。三条跨文档不变量在本卷落地：

| 跨文档不变量                       | 本卷落点                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| **D6**（委托是事件不是实体） | delegation 域双事件 + 因果边闭合（§3、§5）                |
| **P9**（模型可见 = 已记录）  | 装配投影：`context.assembled` + 水位 + 投影器注册（§7）  |
| **V10**（每次放行可归因）    | 四元组 +`causedBy` + 哈希链（§2–§4），供 AUTH 三联回放 |

```text
写入侧（harness 各模块）                 消费侧（只读）
Goal 服务 ──┐                           ├─ 装配投影器 → 模型上下文（LOOP/CONTEXT）
Task 服务 ──┤   append 端口（唯一写入口）  ├─ replay()（AUDIT §3）
Capacity ───┤   校验：四元组可达根 / kind  ├─ validateAttributionChain（GOAL 法律1）
Approval ───┤         闭集 / payload schema├─ 三联回放视图（AUTH §11）
Evaluator ──┤   原子 seq 分配             ├─ 失败账本输入（AUDIT §5）
KillSwitch ─┘   哈希链接链                └─ 四元组过滤 / 因果遍历
                 分区（rootGoalId）追加日志
```

一句话定位：**core 管事实的形态与完整性，不管事实的生产策略**——何时观察、如何压缩、是否注入，全是 LOOP/CONTEXT 的策略；但策略的每次执行以事件留痕。

## 1. 设计裁决记录

| #                                                                      | 裁决                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O-D1                                                                   | **事件只载事实，不做策略**。载荷承载已发生的决策事实（含 harness 拒绝/拦截的结果），不承载"接下来该做什么"——PROVIDER §1.3 原则 1 的同构。判断以 `verdict.issued`、`approval.decided` 等事件形态存在 |
| O-D2                                                                   | **四元组必填且可达根**（GOAL §7 锚点的类型化）：`rootGoalId/goalId` 必填，`taskId/stepId` 按域可选；append 时校验 goalId 沿 parent 链可达根（法律1 的运行时挂点）                                     |
| O-D3                                                                   | **分区与排序**：`rootGoalId` 是分区键；`seq` 分区内严格单调无空洞，是**唯一排序权威**；`at` 是测量事实，`eventId`（ULID）提供全局近时序——三者不混用                                        |
| O-D4                                                                   | **哈希链在事实层**：防篡改载体放 OBSERVATION，AUDIT（AU4）只消费不制造信任                                                                                                                                 |
| O-D5                                                                   | **append-only，更正即追加**：不存在 update/delete API；错误事件以 `stream.corrected` 事件更正（`correction-of` 边），历史不可改写                                                                      |
| O-D6                                                                   | **模型无写权**（P2 引申）：append 主体仅限 harness 内部模块；`actor: 'model'` 表示**事实来源**是模型决策，由 harness 代记，不是模型执行写入                                                        |
| O-D7                                                                   | **记录本身不是效果**：append 端口豁免权限管线——否则"审批放行"这一事实无法被记录（自举死锁）；豁免的前提是写入主体被 O-D6 硬约束                                                                          |
| O-D8                                                                   | **观察三段流水线**（Framework §4.5 的契约化）：`captured`（环境事实）→ `prepared`（脱敏/裁剪/投影）→ `assembled`（注入），三者是三个不同治理点上的三个不同事实，不合并                            |
| O-D9                                                                   | **大载荷出事件流**：事件流不是文件系统；全量转储走 artifact 存储，事件内只留指针 + digest（digest 把链外内容锚定进链）                                                                                     |
| O-D10                                                                  | **exactly-once 事实语义**：`eventId` 全局唯一，幂等去重键；传输层允许 at-least-once，append 端去重                                                                                                       |
| O-D11                                                                  | **闭集注册制**：EventKind 闭集（同 V5 closed-world 精神），注册处为本文 §5；新增 kind 须修订本表并版本化 payload schema                                                                                   |
| O-D12                                                                  | **causedBy 时序先行**：因果边只允许指向已 ack 的事件——委托场景下 `dispatched` 必须先于载荷发出而落盘，使 `received` 的闭合校验可 fail-closed                                                         |
| **术语**：信封｜四元组｜因果边｜水位｜投影器｜转储｜哈希链｜更正 |                                                                                                                                                                                                                  |

---

## 2. 事件信封

```ts
export type Actor = 'model' | 'harness' | 'human' | 'system';
export interface HarnessEvent<P = unknown> {
  eventId: ULID;            // 全局唯一；幂等去重键；近时序
  schemaVersion: number;    // payload schema 版本（O12）
  rootGoalId: ULID;         // 分区键；法律1 归因终点；A/B 锚点
  goalId: ULID;             // 四元组（GOAL §7）
  taskId?: ULID;
  stepId?: ULID;
  kind: EventKind;          // `${domain}.${name}`，闭集（§5）
  actor: Actor;             // 事实来源，非执行者（O-D6）
  emitter?: string;         // 写入组件标识（哪个 harness 模块落的笔）
  at: number;               // 测量事实，非排序权威（O-D3）
  seq: number;              // 分区内严格单调，排序权威（O-D3）
  prevHash: Hash;           // 分区内链；创世事件 = 全零
  hash: Hash;               // H(prevHash ‖ canonical(event 除 hash 外全字段))
  causedBy?: CausedByEdge[];
  payload: P;
}
export interface CausedByEdge {
  eventId: ULID;            // 可跨分区（eventId 全局唯一，分区内链不受影响）
  relation: CausalRelation;
}
export type CausalRelation =
  | 'delegated-by'    // 委托接收 ← 发起事件（D6 闭合）
  | 'approved-by'     // 放行 ← 审批决定（AP-D2 载体）
  | 'observed-from'   // 决策 ← 观察（决策链重建）
  | 'derived-from'    // effective/装配 ← 上游契约/事件（V3、P9）
  | 'retry-of' | 'correction-of' | 'escalates' | 'triggers';
```

**actor 语义澄清表**：

| actor   | 含义                                      | 例                                 |
| ------- | ----------------------------------------- | ---------------------------------- |
| model   | 模型产出的事实（决策/提议），harness 代记 | thinking step、工具调用提议        |
| harness | harness 自身执行/判定的事实               | capacity 执行、脱敏、装配、verdict |
| human   | 人的输入与决定                            | 审批决定、根意图输入               |
| system  | 系统触发与委托接收                        | delegation.received、定时触发      |

## 3. 因果模型

1. **因果边的合法类型**即 `CausalRelation` 闭集；每类边的两端事件域是注册表约束（如 `delegated-by` 只允许 delegation.received → delegation.dispatched）。
2. **跨分区闭合**：A 分区的 `delegation.dispatched` 与 B 分区的 `delegation.received` 由 `eventId` 引用闭合（D6：委托的全部事实在事件流中，实体侧坍缩形态是 `Goal.parent`，二者互为印证——parent 边错配而事件链闭合 → 契约侧 bug；事件边悬空 → 完整性事故）。
3. **闭合校验 fail-closed**：O-D12 时序先行使悬空边=完整性事故；replay（AUDIT）遇悬空边拒绝（与 V13 同构）。
4. **法律1 运行时化**：goal 域事件在 append 时校验 goalId 可达根；`validateAttributionChain(goal, goalIndex)` 的 goalIndex 由事件流投影构建，纯函数零 mock。

---

## 4. 分区、排序与完整性

```ts
export function verifyChain(events: HarnessEvent[]): ChainResult;
// 校验三件事：seq 从 1 起严格连续无空洞；prevHash/hash 链连续；
// 创世事件 prevHash = 全零。任一失败 → ChainResult.broken(atSeq)
export function readPartition(rootGoalId: ULID, from?: { seq: number }): AsyncIterable<HarnessEvent>;
// 只读消费端口，按 seq 全序输出
```

- **seq 连续性 = 完整性的可检验形式**：checkpoint/resume（验收#3）正确性由"恢复后从 last acked seq 续写无空洞"机器可判；
- **篡改检测**：改任何历史字节 → 链断裂 → `verifyChain` fail → replay 拒绝（AU4 联测点）；
- **append 端口语义**（O-D7/O-D10）：`append(event) → ack`；前置校验四件套——四元组可达根（O-D2）、kind 已注册（O-D11）、payload 过 schema、causedBy 指向已 ack 事件（O-D12）；校验失败即拒，**被拒的 append 尝试本身不产生事件**（拒绝发生在成为事实之前，与 AUTH"被拦截的调用要留痕"不冲突——那个留痕是 capacity.rejected 事件，是事实）；
- seq 由端口原子分配；多写入方经端口串行排队（并发实现归 runtime，不变量归本卷）。

---

## 5. 事件分类学（闭集注册表）

各契约文档声明的锚点事件在此**收编为唯一注册处**：GOAL §7 的事件全集、AUTH §11 的 decisionLog、AUDIT 的 verdict、APPROVAL 的审批三态、TOOL 的生命周期。**decisionLog 不设独立存储**（见 §10 修订），它是下表 policy/capacity/approval 域的投影视图。

### 5.1 意图与目标域

| kind                      | 载荷要点                                                                           | 事实内容                         | 锚定            |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------- | --------------- |
| `goal.created`          | kind: intake\|work、statement?、contractDigest、permissionCeiling、budget、parent? | 契约冻结时刻                     | GOAL §3        |
| `goal.contract-revised` | fromDigest、toDigest、via: approvalId?                                             | 契约版本迁移（唯一合法迁移记录） | AUTH §5.2      |
| `goal.ended`            | status、by: verdictId?                                                             | 终态                             | GOAL GoalStatus |
| `intent.parsed`         | rawPayloadRef、statement、sourceSpan                                               | 模型对原料的转写事实             | GOAL D7         |
| `intent.split`          | siblingGoalIds[]、coverageCheck: pass\|warning                                     | 切分决策 + 覆盖软校验结果        | GOAL §5        |
| `intake.completed`      | workGoalIds[]                                                                      | intake 契约达成                  | GOAL §5.2      |

### 5.2 委托域（D6 的承载）

| kind                      | 载荷要点                                                 | 分区               | 因果                                 |
| ------------------------- | -------------------------------------------------------- | ------------------ | ------------------------------------ |
| `delegation.dispatched` | toAgent?、payloadDigest、ceilingOffered、budgetAllocated | 发起方 A           | ← 某 step.ended                     |
| `delegation.received`   | rawPayloadRef                                            | 接收方 B（intake） | **delegated-by** → dispatched |

### 5.3 执行域

| kind                              | 载荷要点                                                                                                        | 说明                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `task.started` / `task.ended` | title、acceptanceDigest、requires[] / status、verdictId?                                                        | Task 生命周期                                                                              |
| `step.started` / `step.ended` | kind:**thinking\|action\|observation**（A1）/ status、usage?、model?、decisionContextDigest、toolCallRef? | LLM 调用的 usage/finishReason 作为厂商披露事实进 step.ended payload（PROVIDER §1.3 同构） |

### 5.4 观察与装配域（本文核心，详见 §6–§7）

`observation.captured` / `observation.prepared` / `context.assembled`

### 5.5 治理域（AUTH decisionLog 收编）

| kind                                           | 载荷要点                                    | 锚定                     |
| ---------------------------------------------- | ------------------------------------------- | ------------------------ |
| `policy.clamp` / `policy.guard-downgrade`  | 规则 id、from→to                           | AUTH §5.2 / §8.4       |
| `policy.derive-reject`                       | requires[]、reason                          | AUTH §5.2 fail-fast     |
| `policy.grant-revision`                      | grantVersion、via: approvalId?              | 根层唯一变宽通道         |
| `policy.escalation-requested` / `-decided` | scope: allowed-once                         | AUTH §7                 |
| `capacity.called`                            | toolId、argsDigest、contractId              | 管线①                   |
| `capacity.executed`                          | effectClasses、sandboxProfile、resultDigest | 管线⑨                   |
| `capacity.pending`                           | approvalId                                  | 管线⑥                   |
| `capacity.rejected`                          | code（结构化）、hint                        | 管线⑥                   |
| `danger.match`                               | ruleId、匹配摘要、outcome                   | AUTH §8.5，一等风险事件 |
| `sandbox.unavailable`                        | platform、backend                           | V13                      |
| `external.full-trust-invocation`             | externalName                                | AUTH §10.3              |

### 5.6 审批域（APPROVAL 落地）

| kind                   | 载荷要点                                | 说明                                           |
| ---------------------- | --------------------------------------- | ---------------------------------------------- |
| `approval.requested` | approvalId、actionDigest                | 人看到什么由此事件承载                         |
| `approval.decided`   | decision、approver、scope: allowed-once | **唯一** pending→executed 触发（AP-D2） |
| `approval.expired`   | —                                      | 结构性拒绝（AP-D4）                            |

### 5.7 词汇与系统域

| kind                                                        | 载荷要点                                             | 锚定                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `tool.registered` / `tool.reviewed` / `tool.conflict` | toolId、version、specDigest / reviewerRef / 冲突摘要 | TOOL T4 / T3                                                                                           |
| `audit.verdict-issued`                                    | verdictDigest、level、value、checkType               | AUDIT AU-D2（评估自身被审计，自举）                                                                    |
| `audit.failure-entered`                                   | failureId、class                                     | AUDIT §5                                                                                              |
| `stream.corrected`                                        | targetEventId、reason、revised?                      | O-D5 更正                                                                                              |
| `system.aborted`                                          | cause: kill-switch\|budget\|signal、by               | kill switch 在格之外，但**中止是事实**，留痕不经 policy（O-D7 例外条款：killSwitch 直连 append） |

---

## 6. 观察域契约（observation.\*）

Framework §4.5 的管线（hook 拦截 → schema 校验 → 脱敏 → 裁剪 → 注入）映射为三个事件：

```ts
// ① 环境事实：harness 看到了什么（未经加工）
export interface ObservationCaptured {
  sourceStepId?: ULID;              // 产出该观察的 action step
  rawRef: string;                   // 全量转储指针（O-D9）
  rawDigest: Hash;                  // 链外内容锚定进链
  schemaCheck: 'pass' | 'fail' | 'n/a';
  trust: 'trusted' | 'untrusted';   // O-D8'：见下
}
// ② harness 改造事实：模型将被允许看到什么形态
export interface ObservationPrepared {
  capturedEventId: ULID;
  projectionDigest: Hash;           // 结构化投影（状态码/关键数值/错误类型/diff）
  redactions: Array<{ at: string; ruleId: string }>;  // 脱敏记录 = 审计信号
  trim?: { originalBytes: number; keptBytes: number };
  trust: 'trusted' | 'untrusted';
}
```

**裁决**：

- **脱敏是治理义务，不是策略**：秘密/敏感路径命中（AUTH §8.3）→ 必须脱敏并留 `redactions` 记录；脱敏规则实现可换，"脱敏发生且有痕"不可换——AGI 后不消失（秘密外泄防线是环境属性）；
- **untrusted 标记的来源清单注册在案**（fact 层）：`net.fetch` 返回、`external.*` 返回、文档类输入。"untrusted 内容不进指令位"是装配**策略**（runtime），事件层只记标记——事实/判断分离；
- **防静默丢失**（PROVIDER §3.3 精神）：captured→prepared 必须成对；trim/redaction 无记录 = 契约违规；观察层验收（附录A #4"模型不依赖长尾记忆理解当前状态"）由 prepared 的结构化投影承载；
- captured 与 prepared **不合并**（O-D8）："环境发生了什么"与"harness 让模型看到什么"是两个审计问题（Framework 设计不变量的两半）。

---

## 7. P9 落地：装配投影（context.assembled）

**模型可见上下文是事件流的确定性投影**：

```ts
export interface AssemblyProjector { version: string; /* 注册制，实现出核（LOOP/CONTEXT 策略） */ }
export function deriveAssembly(
  events: HarnessEvent[],          // seq ≤ watermark 的事件
  projector: AssemblyProjector,
): AssemblyProjection;             // 纯函数：回放可重建"模型当时看到什么"
// ③ 注入事实：模型实际看到了什么
export interface ContextAssembled {
  watermark: { eventId: ULID; seq: number };   // 消费水位
  included: Array<{ eventId: ULID; digest: Hash;
                    role: 'observation' | 'reflection' | 'policy-snapshot'
                        | 'goal-contract' | 'history' | ... }>;
  assemblerVersion: string;
  promptVersion: string;
  prefixStable: boolean;           // 装配器是否保持 KV 前缀（AUTH §11：变更才注入）——装配器自报的执行事实
}
```

**不变量 O8（注入即记录）的精确表述**：

> 任何时刻模型上下文中的实质内容，必须满足：**要么**直接出现于某条 seq ≤ 水位的事件载荷（或其转储内容），**要么**是注册版投影器 `AssemblyProjector(v)` 对 ≤ 水位事件的确定性投影；且装配动作本身已以 `context.assembled` 留痕。
> **防自举回归**：`context.assembled` 引用**水位**而非内嵌全文——装配事件的"内容"由重放 ≤ 水位的事件重建（AU3 的本卷承诺）。装配事件对下一次装配的贡献只是元事实（模型已看过什么、前缀是否稳定），不是内容复制。
> **策略快照注入**（AUTH §11）复用同一机制：effective 快照作为 `role: 'policy-snapshot'` 的 included 项，"模型可见 = 已记录"由 O8 覆盖，AUTH 无需另设通道。

---

## 8. 写入端口与消费端口

| 端口                                                         | 主体                                      | 权限                                               | 语义                                        |
| ------------------------------------------------------------ | ----------------------------------------- | -------------------------------------------------- | ------------------------------------------- |
| `append`                                                   | 仅 harness 内部模块（含 killSwitch 直连） | **豁免权限管线**（O-D7），受 O-D6 主体硬约束 | 校验四件套 → 原子 seq → 接链 → ack       |
| `readPartition` / 过滤 / 因果遍历                          | 任何消费者                                | 只读、无副作用                                     | 按 seq 全序；按四元组过滤；沿 causedBy 遍历 |
| **消费方注册表**（各自消费哪些域，作为配置事实登记）： |                                           |                                                    |                                             |
| 消费者                                                       | 消费域                                    | 产出                                               |                                             |
| ---                                                          | ---                                       | ---                                                |                                             |
| 装配投影器（LOOP/CONTEXT）                                   | 全部                                      | 模型上下文 + context.assembled                     |                                             |
| replay()（AUDIT §3）                                        | 全部                                      | ReplayBundle（events 字段 = readPartition 输出）   |                                             |
| validateAttributionChain（GOAL 法律1）                       | goal/delegation                           | 归因校验结果                                       |                                             |
| 三联回放视图（AUTH §11）                                    | policy/capacity/approval                  | decisionLog 投影                                   |                                             |
| 失败账本（AUDIT §5）                                        | danger/sandbox/capacity.rejected/verdict  | FailureEntry 输入                                  |                                             |
| 进化回路（Framework §7.6）                                  | stream.corrected、failure                 | harness 迭代输入                                   |                                             |

---

## 9. 不变量

| #   | 不变量                                                                            |
| --- | --------------------------------------------------------------------------------- |
| O1  | 四元组必填，goalId 沿 parent 链可达根（法律1 运行时化）                           |
| O2  | EventKind 闭集注册；未注册 kind 拒绝 append                                       |
| O3  | seq 分区内从 1 起严格单调、无空洞；空洞 = 完整性事故                              |
| O4  | 分区内哈希链连续，`verifyChain` 可独立校验；链断即证据不可信                    |
| O5  | append-only；更正只能以`stream.corrected` 追加，无 update/delete                |
| O6  | append 主体仅限 harness；模型无事件写权；actor 标注事实来源                       |
| O7  | append 豁免权限管线；killSwitch 直连 append 留痕                                  |
| O8  | 注入即记录：模型可见的实质内容 ⊆ 事件 ∪ 注册投影(事件)，且装配有痕（P9）        |
| O9  | 观察必成对（captured↔prepared）、必带 trust 标记与脱敏/裁剪记录；无痕改造 = 违规 |
| O10 | eventId 全局唯一，append 幂等去重（exactly-once 事实语义）                        |
| O11 | 载荷承载已发生的决策事实，不承载"接下来该做什么"                                  |
| O12 | payload schema 版本化；旧版本可读（replay 跨版本）                                |
| O13 | causedBy 只指向已 ack 事件（时序先行）；悬空边 = 完整性事故，fail-closed          |
| O14 | 大载荷出事件流：链外内容必须以 digest 锚定，指针可寻址                            |

---

## 10. 与各契约的衔接矩阵（含一处修订）

| 文档                         | 衔接                                                                                                                                             | 性质 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| GOAL §7                     | 其声明的事件全集收编为 §5 注册表；"事件契约完整定义属后续观测模块"由此兑现                                                                      | 收编 |
| GOAL 法律1/2                 | append 时校验可达根；goal.created 载荷携带 ceiling/budget 供`validateCeilingMonotonicity` 从事件流投影校验                                     | 落地 |
| AUTH §11                    | decisionLog 全部事件收编 policy/capacity/danger/sandbox/external 域                                                                              | 收编 |
| AUTH §11"旁轨"              | **重释义**：旁轨指架构上独立于 policy 管线（不被 policy 阻塞），**非独立存储**——decisionLog 是事件流投影视图                       | 修订 |
| AUDIT §3 ReplayBundle       | `decisionLog` 字段 := `projection(events, kinds ⊆ policy/capacity/approval)`；`events` := readPartition 输出。消除 AUDIT 初稿中的双真相源 | 修订 |
| AUDIT AU4                    | 消费`verifyChain`；链断 → replay 拒绝                                                                                                         | 消费 |
| APPROVAL AP-D2               | `approval.decided` 是唯一 pending→executed 触发事件，载体即本卷                                                                               | 落地 |
| TOOL T4                      | tool.registered/reviewed/conflict 生命周期经事件流；ToolSpec 注册表本体仍是 TOOL 契约的存储，事件只承载生命周期事实                              | 分工 |
| PROVIDER                     | LLM 调用 = action step；usage/finishReason 作为厂商披露事实进 step.ended payload；"事实不做判断"同构                                             | 同构 |
| FRAMEWORK §4.5 / 附录A#3/#4 | 三段观察流水线落地；seq 连续性 = 任意点恢复的可检验形式                                                                                          | 落地 |

---

## 11. 删除测试表

| 删除候选                 | 后果                                                  | 裁决         |
| ------------------------ | ----------------------------------------------------- | ------------ |
| 四元组                   | 法律1/坐标系衔接断，回放无法按 Goal 聚合              | 留           |
| seq                      | 恢复完整性（#3）、全序、防篡改定位全部失据            | 留           |
| 哈希链                   | AU4 无载体，审计退化为"日志说啥信啥"                  | 留           |
| causedBy                 | 委托闭合、审批→放行、观察→决策不可机器判，D6/V10 断 | 留           |
| actor                    | 行动者/评价者分离（AU7）不可验证                      | 留           |
| captured/prepared 拆分   | "环境发生什么"与"模型看到什么"混淆，脱敏无痕          | 留           |
| context.assembled + 水位 | P9 无载体，"模型看到什么"靠回忆                       | 留           |
| untrusted 标记           | 注入爆炸半径失控（AUTH §9.1 防线失据）               | 留           |
| 独立 decisionLog 存储    | 双真相源（同 GOAL 删 children 反向字段之理）          | 不设（投影） |
| 事件内嵌策略判断字段     | 事实/判断混淆，O11 失守                               | 不设         |
| 事件 update/delete API   | 审计不可篡改性破坏；更正语义已由 O5 覆盖              | 不设         |
| `at` 作为排序权威      | 与 seq 双真相源                                       | 不设         |

---

## 12. AGI 演化预测

| 组成                                                               | 演化                                                                                              | 依据                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 装配策略实现（压缩/检索/裁剪/投影器）                              | 被模型吸收，实现删除；**O8 降级为记账义务**：模型自由管理上下文，但水位 + digest 留痕不消失 | 服务"呈现"                                  |
| schema 结构化投影的生成                                            | 部分吸收                                                                                          | 服务"呈现"                                  |
| 脱敏义务与 redactions 留痕                                         | **不消失**                                                                                  | 秘密外泄防线 = 环境属性                     |
| trust 标记与 untrusted 来源清单                                    | **不消失**（内容治理部分吸收，标记事实保留）                                                | 同上                                        |
| 四元组 / seq / 哈希链 / append-only / causedBy 闭合 / O13 时序先行 | **不变**                                                                                    | 责任归属与不可逆性是环境属性；删=删审计哲学 |
| kind 闭集注册制                                                    | 不变，域随治理面演进增补                                                                          | closed-world                                |

**操作性判据**（GOAL §9 判据的事件层版本）：问"这段代码服务呈现还是服务事实"——服务呈现/压缩/检索的设计上就该被删；服务事实留存/因果闭合/完整性校验的删它们等于删架构哲学。

---

## 13. 示例走查

| 场景              | 事件链                                                                                                                                                                                                       | 检验点                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 多意图输入        | goal.created(intake) → step.ended(thinking) → intent.parsed → intent.split{2 兄弟} → goal.created(work×2, 同 rootGoalId) → intake.completed                                                            | 兄弟共享 rootGoalId；coverage 软校验留痕             |
| A 委托 B          | A 分区：step.ended(action) → delegation.dispatched；B 分区：goal.created(intake, parent=delegation) → delegation.received(**delegated-by** dispatched)                                               | 跨分区因果闭合；O13 时序先行                         |
| `rm -rf src/`   | step.ended(action) → capacity.called →**danger.match**{rm→delete} → capacity.pending → approval.requested → approval.decided(rejected) → capacity.rejected(GATED_REJECTED) → step 状态 blocked | V8/V16 链路全程可回放                                |
| net.fetch 大 HTML | observation.captured(rawRef, digest,**untrusted**) → observation.prepared(trim 200KB→2KB, untrusted) → context.assembled(included, watermark)                                                       | O9/O14；untrusted 内容进的是数据位（策略在 runtime） |
| 读`.env`        | observation.captured → observation.prepared(redactions[secret-rule]) → danger.match（恒 gated）→ approval 链                                                                                              | 脱敏留痕 = 审计信号                                  |
| 中断恢复          | 从 last acked seq 重放 → effective 重派生 → context 重装配                                                                                                                                                 | O3 无空洞 = 恢复正确的可判形式                       |
| 事后篡改          | 修改历史事件任一字节                                                                                                                                                                                         | verifyChain broken → replay 拒绝（AU4）             |
| 写错事件          | stream.corrected(correction-of target, reason)                                                                                                                                                               | O5：历史不改写，更正有痕                             |

---

## 14. 自检清单

1. `verifyChain` / 四元组可达根校验 / 因果闭合校验均为纯函数，测试零 mock；
2. 场景跑通：单意图、多意图切分、三层委托链（跨分区闭合）、审批放行与拒绝、kill switch 中止、截断流恢复、篡改注入；
3. 类型系统上：无法构造缺四元组的事件、无法构造未注册 kind、无法构造 `delegated-by` 两端域错配的边；
4. **回放等价性测试**：任意截断点 → deriveAssembly(重放 ≤ 水位) 与该点 context.assembled 记录的投影 digest 一致（O8 的自动化）；
5. seq 空洞与哈希链断裂的故障注入：verifyChain 必报、replay 必拒；
6. 幂等测试：同 eventId 重复 append → no-op 不产生第二事实；
7. 消费端口只读性：任何消费调用不改变分区状态。
