# Core 契约设计：Goal-Task-Step

> **范围**：本文档只定义归因坐标系（Goal / Task / Step 及其委托结构）

## 1. 词汇结构

```
Goal（意图单元）── 意图片段的契约化：冻结验收 + 归因 + 治理上限
  └─ Task（目标单元）── 验收锚定唯一 Goal 的执行单元
       └─ Step（归因原子）── deliberation | invocation
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
- 解析决策（`parsedByStepId`）不再作为字段存在——解析是 intake Goal 树下的一个 deliberation Step，归因由结构 + 事件流天然表达（裁决 D7）。

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

StepKind 只有两个值，按**事实来源**二分：`deliberation`（LLM 内在，一次模型输出）与 `invocation`（外在实际，一次对外部世界的调用）。决策链的三个环节（思考 / 回答与提议 / 执行与结果）落在二者的字段上，而不是各自成为一个 kind。

```ts
// ═══ step.ts ═══
export type StepKind = 'deliberation' | 'invocation';

/** 模型一次输出的决策事实：推理、回答、提议的工具调用（三者可并存） */
export interface DeliberationPayload {
  thinking?: string;
  answer?: string;
  /** 模型本轮提议的工具调用；callId 与 InvocationPayload.callId 配对 */
  toolCalls?: ToolCall[];
}

/** harness 对外部世界的一次实际调用及其结果 */
export interface InvocationPayload {
  toolName: string;
  arguments: Record<string, unknown>;
  /** 与 DeliberationPayload.toolCalls[].callId 配对 */
  callId?: string;
  /** 工具实际执行的工作目录（展示/追溯） */
  cwd?: string;
  output?: string;
}

export type StepPayload = DeliberationPayload | InvocationPayload;

/** 失败事实：四源标签（model|tool|context|policy）；工具/策略失败不再在 payload 上编码 */
export interface StepError {
  code: string;
  message: string;
  source?: 'model' | 'tool' | 'context' | 'policy';
  retryable: boolean;
  cause?: unknown;
}

export type StepStatus =
  | 'pending' | 'running' | 'completed' | 'error' | 'skipped' | 'blocked' | 'aborted';

interface StepBase {
  stepId: string;
  taskId: string;
  goalId: string;
  model?: ModelRef;
  usage?: Usage;
  status: StepStatus;
  error?: StepError;
  startedAt: number;
  endedAt?: number;
}

/** 归因原子：kind 是唯一判别式，payload 随 kind 自动收窄 */
export type Step = StepBase &
  (
    | { kind: 'deliberation'; payload: DeliberationPayload }
    | { kind: 'invocation'; payload: InvocationPayload }
  );
```

**为什么是二分而非三/四分**（最小抽象）：
- 三/四分法把同一来源的不同**字段**提升成 kind：thinking 与 intent 都是模型的一次输出，observation 只是 invocation 的结果。字段能表达的不再增设 kind。
- kind 是**唯一判别式**：`Step` 是可判别联合，`step.kind` 唯一决定 `step.payload` 的类型，不存在 kind 与 payload.type 的双真相源。
- 决策链重建仍完整：deliberation 回答"模型看到什么后决定了什么（推理 / 回答 / 提议了哪些调用）"，invocation 回答"实际执行了什么、环境返回什么"；两者通过 `callId` 配对，模型看到 → 决定 → 执行 → 结果全程可追。
- **失败是一等事实**：工具 / 策略失败由 `status` + `error.source` 表达，不再用 payload 上的 `isError` 布尔或 `structured` 旁路字段（默认工具调用桥只返回 string 结果，结构化旁路无消费者）。

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

切分本身是模型的概率决策，切错代价极高（错切 = 全部后续归因错误）。归因闭合不能在系统自身的解析决策处豁口——解析决策必须是树上的一个 deliberation Step，而 Step 需要 Goal 可挂：

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
A 的 Goal₁ ── Task ── Step_s（deliberation 提出委托 / invocation 执行委托）
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
| `StepKind` 二分（deliberation / invocation） | **无断裂**：决策链三环节坍缩为字段（推理/回答/提议、执行/结果），按来源而非环节分类；字段可表达的不增设 kind | **二分（最小抽象）** |
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
