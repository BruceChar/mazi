# Core 契约设计：Goal-Task-Step

> **范围**：本文档只定义归因坐标系（Goal / Task / Step 及其委托结构）。权限、工具、观测、provider 端口等契约模块尚未讨论定型，不在本文范围。
> **版本**：v0.5（解散 Delegation 实体；IntentSlice 坍缩为 Goal 字段）

---

## 1. 设计裁决记录

本章沉淀的全部结论，按讨论顺序编号，后续模块设计须与之保持一致：

# AHF_CORE_OBSERVATION.md（事件流契约）

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
-------------------------------------------------------------------------------------------------------------------------------------------------

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
| actor | 含义 | 例 |
|---|---|---|
| `model` | 模型产出的事实（决策/提议），harness 代记 | thinking step、工具调用提议 |
| `harness` | harness 自身执行/判定的事实 | capacity 执行、脱敏、装配、verdict |
| `human` | 人的输入与决定 | 审批决定、根意图输入 |
| `system` | 系统触发与委托接收 | delegation.received、定时触发 |
---------------------------------------------------------

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

| 组成                                                                                                                                                                                | 演化                                                                                              | 依据                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 装配策略实现（压缩/检索/裁剪/投影器）                                                                                                                                               | 被模型吸收，实现删除；**O8 降级为记账义务**：模型自由管理上下文，但水位 + digest 留痕不消失 | 服务"呈现"                                  |
| schema 结构化投影的生成                                                                                                                                                             | 部分吸收                                                                                          | 服务"呈现"                                  |
| 脱敏义务与 redactions 留痕                                                                                                                                                          | **不消失**                                                                                  | 秘密外泄防线 = 环境属性                     |
| trust 标记与 untrusted 来源清单                                                                                                                                                     | **不消失**（内容治理部分吸收，标记事实保留）                                                | 同上                                        |
| 四元组 / seq / 哈希链 / append-only / causedBy 闭合 / O13 时序先行                                                                                                                  | **不变**                                                                                    | 责任归属与不可逆性是环境属性；删=删审计哲学 |
| kind 闭集注册制                                                                                                                                                                     | 不变，域随治理面演进增补                                                                          | closed-world                                |
| **操作性判据**（GOAL §9 判据的事件层版本）：问"这段代码服务呈现还是服务事实"——服务呈现/压缩/检索的设计上就该被删；服务事实留存/因果闭合/完整性校验的删它们等于删架构哲学。 |                                                                                                   |                                             |

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

---

## 15. 修订说明

1. **对 AUDIT §3 的修订**：ReplayBundle.decisionLog 由并列字段改为事件流投影视图——单一事实层原则贯彻（本轮 §10）；
2. **对 AUTH §11"旁轨"的重释义**：独立于 policy 管线 ≠ 独立存储；
3. **GOAL §7 收编 + A1**：StepKind `'action'` 补全在本卷 step 域事件中固化，GOAL 文本待下版同步。
   **总结**：一个信封（四元组 + actor + 因果边）、一条链（seq 全序 + 哈希链 + append-only）、一条流水线（captured → prepared → assembled，P9 的三块事实）、一张闭集注册表（全域事件锚点收编）。事实层不判断——判断以事件形态回到事实层被审计；模型可见的与审计记录的，从这一卷起是同一份数据。

| #  | 裁决                                                                                                                              | 状态     |
| -- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1 | 词汇按归因维度命名：Goal（意图归因）、Task（目标归因）、Step（动作归因），取代 Session/Turn/Step（UX 语义残留）                   | 定稿     |
| D2 | Goal vs Intent：Intent 是模型的词（概率性解析产物），Goal 是 harness 的词（冻结契约、机械可判验收）。Intent 只以留痕字段进入 core | 定稿     |
| D3 | 多意图在 Goal 层切分，不在 Task 层：Task 验收必须唯一锚定一个 Goal 契约                                                           | 定稿     |
| D4 | 切分决策需要归因宿主 → intake 变体 Goal                                                                                          | 定稿     |
| D5 | 委托来源泛化：human / agent / system 的输入是同一种东西                                                                           | 定稿     |
| D6 | Delegation 解散：委托是事件不是实体；治理上限挂 Goal；兄弟共享来源由 parent 树表达                                                | 本版修正 |
| D7 | IntentSlice 坍缩：statement / sourceSpan 成为 Goal 字段，解析 step 归因由树结构与事件流表达，独立类型删除                         | 本版修正 |
| D8 | AGI 演化：模型吸收 Goal 层的劳动（解析/切分/协商编排），不吸收其职能（冻结/机械可判/审批锚点）。Goal 层从解析层退化为公证层       | 定稿     |

## 2. 词汇结构

```
Goal（意图单元）── 意图片段的契约化：冻结验收 + 归因 + 治理上限
  ├─ intake 变体 ── 承载意图解析 Step，切分的锚点（自举）
  └─ Task（目标单元）── 验收锚定唯一 Goal 的执行单元
       └─ Step（归因原子）── thinking | tool_call | observation
```

归因三维度与审计问题的对应（坐标系的存在理由）：

| 词汇 | 审计员的问题                               | 删除后果                                 |
| ---- | ------------------------------------------ | ---------------------------------------- |
| Goal | 谁想要什么、承诺的验收是什么、约束上限多少 | 目标漂移失去外部锚点，审批失去可指认对象 |
| Task | 这个动作服务于哪个子目标、对照什么验收     | 反思反馈无法锚定条款，四源归因断裂       |
| Step | 哪次调用、当时看到什么、什么权限           | 决策链重建失效                           |

## 3. 契约定义

### 3.1 Goal

```ts
// ═══ goal.ts ═══
export type OriginKind = 'human' | 'agent' | 'system';
export type GoalStatus =
  | 'active' | 'succeeded' | 'failed' | 'aborted' | 'timeout';
/** 原始载荷：原料必须完整保存（多意图切分的输入） */
export interface RawPayload {
  contentType: 'text' | 'structured' | 'event';
  content: string | Record<string, unknown>;
  receivedAt: number;
}
/** parent 引用：Delegation 实体解散后的坍缩形态（裁决 D6）
    两种类型覆盖归因链的全部边 */
export type GoalParent =
  /** 切分边：我是从哪个 Goal（intake）切出来的兄弟之一 */
  | { type: 'split'; goalId: string }
  /** 委托边：我是被上游哪个 step 委托出来的
      （agent 委托 / human 输入 / system 触发统一走这条边） */
  | { type: 'delegation'; goalId: string; taskId?: string; stepId: string };
export interface Goal {
  goalId: string;                       // ULID
  /** 根 Goal ID（沿 parent 链的最顶层；根自身 = goalId）。
      A/B 分桶锚点与归因链终点（法律锚点，见 §6） */
  rootGoalId: string;
  /** 上游引用。根 Goal 无 parent，此时 origin 必填 */
  parent?: GoalParent;
  /** 接收侧来源标记：根 Goal 必填；非根 Goal 由 parent 铐链隐含 */
  origin?: { kind: OriginKind };
  /** 原始载荷：委托接收处持有（根 Goal 必填，兄弟经 parent 引用，无复制） */
  rawPayload?: RawPayload;
  /** 意图陈述（原 IntentSlice.statement 坍缩至此，裁决 D7）：
      模型对 rawPayload 中本 Goal 所指意图片段的转写 */
  statement: string;
  /** 在 rawPayload 中的定位（原 IntentSlice.sourceSpan）：
      覆盖性软校验的输入，供审计比对转写忠实度 */
  sourceSpan?: { start: number; end: number } | { jsonPointer: string };
  /** 变体标记：intake = 承载切分的系统 Goal（见 §5） */
  kind: 'intake' | 'work';
  contract: GoalContract;               // 冻结的契约（字段集见 §4）
  /** 治理上限（原 Delegation 的 ceiling 宿主，裁决 D6） */
  permissionCeiling: PermissionLevel;
  budget: BudgetAllocation;
  status: GoalStatus;
  createdAt: number;
  endedAt?: number;
}
```

**字段纪律说明**：

- `parent` 是唯一的结构引用，不存在 `children` / `siblingGroup` 之类的反向字段——它们可从 parent 边派生（单一真相源）；
- `rawPayload` 只在树根持有。多意图兄弟通过 parent 链访问，审计时“这次输入的原料”有唯一存放处；
- 解析决策（`parsedByStepId`）不再作为字段存在——解析是 intake Goal 树下的一个 thinking Step，归因由结构 + 事件流天然表达（裁决 D7）。

### 3.2 Task

```ts
// ═══ task.ts ═══
export interface Task {
  taskId: string;
  /** 唯一归属：验收锚定的编译期强制（裁决 D3 的类型实现） */
  goalId: string;
  title: string;
  /** 验收锚定 goal.contract 的具体条款 */
  acceptance: AcceptanceSpec;
  capacity: Capacity;                   // 类型细节属后续模块，此处仅引用
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
  parentPlanNodeId?: string;            // 关联 Plan 图（Plan 契约属后续模块）
}
```

### 3.3 Step

```ts
// ═══ step.ts ═══
/** 归因原子：无预设词汇，容纳决策链的三个必需环节 */
export type StepKind = 'thinking' | 'tool_call' | 'observation';
export interface Step {
  stepId: string;
  taskId: string;
  goalId: string;
  kind: StepKind;
  payload: ThinkingPayload | ToolCallPayload | ObservationPayload;
  model?: ModelRef;
  usage?: Usage;
  status: 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'blocked';
  error?: HarnessError;                 // 四源标签（model|tool|context|policy）
  /** 决策依据快照（审计）：当时的上下文摘要 + prompt 版本 */
  decisionContext?: DecisionContext;
  startedAt: number;
  endedAt?: number;
}
```

**Step 的三种 kind 都是审计必需**，这是它区别于 "Call" 的原因：thinking 归因“模型决定了什么”、tool_call 归因“做了什么”、observation 归因“环境返回了什么”。砍掉任何一个，决策链重建（“模型看到什么、决定什么、执行什么、环境发生什么”）出现断口。

## 4. GoalContract（Goal 的契约载荷）

```ts
export interface GoalContract {
  successConditions: CheckableCondition[];   // 机械可判（本坐标系的存在理由之一）
  failureConditions: CheckableCondition[];
  forbiddenResources: ResourcePattern[];
  budget: BudgetAllocation;                  // Goal.budget 的契约源
  terminationPolicy: TerminationPolicy;
  riskProfile: RiskProfile;                  // 供策略选择与后续权限/审批模块消费
}
```

**契约的消费者不是 actor**（裁决 D8 的核心论证）：评估器需要独立于行动者的参照物来判 done；审批人需要指认“批的是服务于哪个条款的动作”；审计员需要重建决策链；漂移对抗需要每次注入可重载的外部锚点。这些角色都读不到模型的内部状态——模型把意图理解内化得再好，也只消除“actor 需要提醒”这一项消费者。契约是**角色间协议**，不是记忆辅助。`successConditions` 中 `checkType: 'semantic'` 的占比是健康度指标——能用确定性代码判的绝不交给 judge。

## 5. 多意图切分与 intake 变体

### 5.1 切分发生在 Goal 层（裁决 D3）

**单 done 语义测试**：

> 合并候选意图组的 successConditions，问：任一意图失败时，整体“完成”是否仍可定义？
>
> - 不可定义（部分成功语义）→ 切分为兄弟 Goal；
> - 意图间是产出依赖（B 的验收引用 A 的产出物）→ 同一 Goal 内的多个 Task。| 输入                                                                                                                                                                                                                         | 判定                            | 结构                                   |
>   | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
>   | “调研 X 并基于调研写报告”                                                                                                                                                                                                  | 报告验收引用调研产出 → 单 done | 一个 work Goal，Task₁→Task₂         |
>   | “修 bug Y，顺便调研 Z”                                                                                                                                                                                                     | 两个独立 done                   | 两个兄弟 work Goal，parent 同一 intake |
>   | agent 结构化委托含 3 个 task 条目                                                                                                                                                                                            | 显式多意图                      | 3 个兄弟 work Goal                     |
>   | 三条论证（为何不沉到 Task 层）：验收锚定唯一性（多目标共契约 → done 判定崩坏，反思反馈无法锚定条款）；治理粒度（预算/权限/漂移检测以契约为锚，共契约互相污染）；失败隔离（Goal 是回滚与失败报告的天然边界，兄弟独立成败）。 |                                 |                                        |

### 5.2 intake 变体（裁决 D4）

切分本身是模型的概率决策，切错代价极高（错切 = 全部后续归因错误）。归因闭合不能在系统自身的解析决策处豁口——解析决策必须是树上的一个 thinking Step，而 Step 需要 Goal 可挂：

```ts
// 判别：goal.kind === 'intake'
// 契约固定且机械可判：该次输入的全部意图已识别并完成契约化
//     （判定 = 子 Goal 创建事件齐全）
```

- **human 输入**：根 Goal 是 intake；解析 Step 在其树下；切分完成即终结（寿命极短）；
- **agent 委托**：B 侧同样建 intake——B 的接收处理与 A 侧发起 step 通过 `parent(delegation).stepId` 闭合链路；
- **单意图快速路径**：intake 契约化一个 work Goal 后终结，无兄弟产生；
- **自举性**：Goal 层自己的工作（意图解析、切分）被同一套坐标系审计——可回溯、可复盘、可人工修正。

### 5.3 多 agent 编排不引入新原语（裁决 D5 + D6）

Agent A 委托 B 的完整结构：

```
A 的 Goal₁ ── Task ── Step_s（某 thinking/tool_call 发起委托）
                          │  委托事件（delegation.dispatched，记录于 A 的 trace）
                          ▼
B 侧根 Goal₂ ── parent: { type: 'delegation', goalId: Goal₁, stepId: s }
   （intake 变体，持有 rawPayload、permissionCeiling ≤ A 发起上下文）
        └── 切分 → work Goal 树
```

human 输入、agent 委托、system 触发统一走 `parent: delegation` 边——**多意图切分与多 agent 编排是同一个结构问题**：都是树上的子树生成，共享同一套归因校验、同一套预算/权限递减、同一个 A/B 锚点（rootGoalId）。

## 6. 法律落点（坐标系相关的部分）

四条法律中，与坐标系直接相关的前两条在此定型；权限/审批法律的完整定义属后续模块，此处只声明其锚点。
**法律 1：归因链闭合**

```
任何 Goal 沿 parent 边逐级回溯，必须终止于一个
origin.kind ∈ { human, system } 的根 Goal。没有孤儿动作。
```

校验为纯函数：`validateAttributionChain(goal, goalIndex) → AttributionResult`。B 被委托做的事，永远能指认到“哪个根意图下的哪个上游动作发起的委托”。
**法律 2：治理上限单调递减**

```
委托边上：child.permissionCeiling ≤ 委托发起上下文的权限；
          child.budget ≤ 上游预算分配。
切分边上：兄弟 Goal 的 budget 之和 ≤ parent(intake).budget。
唯一升权路径 = 人类审批（属后续审批契约）。
```

原 Delegation 时代的两条法律（权限递减、预算分区）在 Goal 树上**合并为一条**——这正是 D6 裁决的结构红利：切分边和委托边是同一棵树上的两种边，递减法律天然统一，封死“拆意图绕预算”与“委托下游绕权限”两条越权路径用的是同一个校验函数。

**法律 3（声明，细节后续）：审批终止于人类**。锚点：ApprovalRecord 的可指认对象是 `{ goalId, conditionId }`——即本坐标系的 Goal 与契约条款。

**软校验：意图覆盖**

兄弟 Goal 的 `sourceSpan` 并集应覆盖 rawPayload 主体。覆盖性是语义级判断（模型职责），故降级为软校验——未覆盖区间产生审计警告事件，不阻断。

## 7. 与观测事件的衔接（仅声明锚点）

事件全集中与坐标系相关的类型：`goal.created / goal.ended / delegation.received / delegation.dispatched / intent.parsed / intent.split / intake.completed / task.started / task.ended / step.started / step.ended`。所有事件携带 `{ goalId, taskId?, stepId?, rootGoalId }`。**委托是事件而非实体**（D6）——它的全部事实（发起者、载荷、时刻）记录在事件流中，实体侧的坍缩形态就是 `Goal.parent`。事件契约的完整定义属后续观测模块。

## 8. 删除测试表（本层）

| 删除候选                                    | 后果                                                                | 裁决                 |
| ------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| Goal / Task / Step 三层结构                 | 归因链断裂，验收#1/#8/#12 失去类型层强制                            | 留                   |
| `rootGoalId`                              | 法律 1 失去终点；A/B 锚点、跨 Goal 聚合失效                         | 留                   |
| `Goal.parent`（含 split/delegation 两型） | 法律 1/2 失去链结构；兄弟无共享来源；多 agent 链路断裂              | 留                   |
| `Goal.permissionCeiling / budget`         | 法律 2 失去节点，越权路径打开                                       | 留                   |
| `Goal.rawPayload`（仅根持有）             | 意图覆盖校验、转写忠实度审计失去原料                                | 留（仅根必填）       |
| `Goal.statement / sourceSpan`             | 切分决策不可回溯，转写忠实度不可比对                                | 留                   |
| `kind: 'intake'` 变体                     | 解析 Step 无家可挂，归因闭合在系统自身决策处豁口                    | 留                   |
| `Task.goalId` 唯一归属                    | 验收锚定多义，反思反馈无法锚定条款                                  | 留（编译期强制）     |
| `StepKind` 三值中砍掉 thinking            | “模型决定了什么”归因缺失，决策链断口                              | 留                   |
| Delegation 独立实体                         | **无断裂**：全部职能可由 parent 边 + 委托事件 + Goal 字段推导 | **解散（D6）** |
| IntentSlice 独立类型                        | **无断裂**：statement/sourceSpan 并入 Goal，解析归因由树表达  | **坍缩（D7）** |
| `children` / `siblingGroup` 反向字段    | **无断裂**：可从 parent 边派生，双真相源风险                  | **不设**       |
| `parsedByStepId` 字段                     | **无断裂**：由 intake 树结构 + 事件流隐含                     | **不设**       |

---

## 9. AGI 演化预测（本层）

| 组成                                          | 演化                             | 依据                                             |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| 解析/切分编排（intake 的 runtime 管线）       | 削薄 → 删除                     | 理解劳动被模型吸收（脚手架纪律）                 |
| 协商回路                                      | 频率趋零；不可逆目标保留签字仪式 | commit 是后果转移仪式，非纠错                    |
| 契约**内容**生产                        | 模型自撰，成本趋零               | 能力内化                                         |
| 契约**形式**（冻结、机械可判、ceiling） | 不变，且承压增大                 | 消费者是评估器/审批人/审计员，读不到模型内部状态 |
| `kind: 'intake'` 变体                       | 可能坍缩为标记字段               | 单步高可靠解析后留痕必要性下降                   |
| 三层结构 + parent 链 + 法律 1/2               | 不变                             | 归因完备性下限；不可逆性/责任归属是环境属性      |

**判断某段 Goal 层代码会不会被 AGI 淘汰的操作性判据**：问“它服务理解还是承诺”——服务理解的（解析编排、切分管线）设计上就该被删；服务承诺的（冻结、机械可判、审批锚点、递减校验）删它们等于删架构哲学。

---

## 10. 自检清单（本层）

1. `validateAttributionChain` / `validateCeilingMonotonicity` 为纯函数，测试零 mock；
2. in-memory Goal 图构造器跑通：单意图、多意图切分、三层 agent 委托链、system 触发四种场景的法律校验；
3. 类型系统上：无法构造缺三层 ID 的 Step、无法构造 `taskId` 指向多 Goal 的 Task；
4. 多 Goal 专项：兄弟共享 rootGoalId（A/B 同桶）、切分预算分区合法、委托链权限递减合法、兄弟独立成败互不牵连；
5. 从任意截断的事件流 + Goal 树可重建归因链至根（法律 1 自动化为单元测试）。
