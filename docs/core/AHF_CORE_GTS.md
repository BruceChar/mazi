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
/** 统一状态词表：Goal / Task / Step 共用（Step 另有 'error' | 'skipped'） */
export type Status =
  | 'pending' | 'active' | 'succeeded' | 'blocked' | 'failed' | 'aborted' | 'timeout';
export type GoalStatus = Status;
/** 原始载荷：原料完整保存 */
export interface RawPayload {
  contentType: 'text' | 'structured' | 'event';
  content: string | Record<string, unknown>;
  receivedAt: number;
}
export interface Goal {
  goalId: string;                       // ULID（运行会话 id；事件/存储层 rootGoalId 语义 = goalId）
  /** 接收侧来源标记：user intent 直接产 Goal（无树结构，Goal 相互独立） */
  origin?: { kind: OriginKind };
  /** 原始载荷：本 Goal 的输入原料 */
  rawPayload?: RawPayload;
  /** 意图陈述（原 IntentSlice.statement 坍缩至此，裁决 D7）：
      模型对 rawPayload 中本 Goal 所指意图片段的转写 */
  statement: string;
  /** 在 rawPayload 中的定位（原 IntentSlice.sourceSpan）：
      覆盖性软校验的输入，供审计比对转写忠实度 */
  sourceSpan?: { start: number; end: number } | { jsonPointer: string };
  contract: GoalContract;               // 冻结的契约（字段集见 §4）
  /** 治理上限（意图直接配置） */
  permissionCeiling: PermissionLevel;
  budget: BudgetAllocation;
  status: GoalStatus;
  createdAt: number;
  endedAt?: number;
}
```

**字段纪律说明**：

- 扁平模型（2026-09-17 变更，见 §8）：Goal **无 `rootGoalId` / `parent`**——user intent 直接产生 Goal，Goal 相互独立，只挂下属 Task；`rootGoalId` 仅保留在事件/存储/API 层作为**运行会话 id**（数值恒等于 goalId）；
- `rawPayload` 由本 Goal 持有（无树根概念，不存在"兄弟经 parent 引用"）；
- 解析决策（`parsedByStepId`）不再作为字段存在——解析是本 Goal 下的一个 deliberation Step，归因由结构 + 事件流天然表达（裁决 D7）；
- 不再有 `kind: 'intake' | 'work'` 变体：Goal 本身就是可挂载解析 Step 的普通 Goal。

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
  status: TaskStatus;                   // = Status（统一词表）
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

export type StepStatus = Status | 'error' | 'skipped';

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

## 5. 多意图切分（已取消，2026-09-17）

> **变更记录**：原 §5.1-5.3 定义「切分发生在 Goal 层 + 兄弟 Goal（parent: split）+ agent 委托（parent: delegation）」。
> 按最新指令改为**扁平模型**：user intent 直接产生一个 Goal，Goal 相互独立、只挂下属 Task；
> 无 parent 边、无切分、无委托结构。多意图输入由调用方显式拆成多个 Goal 会话，或在同一 Goal 内排多个 Task（Plan 图）。
> 可执行性不再需要「叶子判定」：`planGoalTree` 取 status=active 的全部 Goal。

## 6. 法律落点（坐标系相关的部分）

> **变更记录（2026-09-17）**：扁平化后**取消「法律 1 归因链闭合」与「法律 2 治理上限单调递减」**
> （两者依赖 parent/rootGoalId 树结构；Goal 相互独立后无链可循、无层级可递减）。
> 对应纯函数 `validateAttributionChain` / `validateCeilingMonotonicity` 已从 core 移除。
> 治理上限仍在 Goal 上（`permissionCeiling` / `budget` 由意图来源直接配置），但不再有跨 Goal 的单调性约束。

**法律 3（声明，细节后续）：审批终止于人类**。锚点：ApprovalRecord 的可指认对象是 `{ goalId, conditionId }`——即本坐标系的 Goal 与契约条款。

**软校验：意图覆盖（取消）**

> 原「兄弟 Goal 的 sourceSpan 并集应覆盖 rawPayload 主体」依赖切分结构，随 §5 一并取消；
> 单个 Goal 的 `sourceSpan` 仍保留，供转写忠实度审计比对。

## 7. 与观测事件的衔接（仅声明锚点）

事件全集中与坐标系相关的类型：`goal.started / goal.ended / task.started / task.ended / step.started / step.ended`。所有事件携带 `{ goalId, taskId?, stepId?, rootGoalId }`，其中 `rootGoalId` 为**运行会话 id**（恒等于 goalId；用于 JSONL 分文件与 SSE 过滤）。事件契约的完整定义属后续观测模块。

## 8. 删除测试表（本层）

| 删除候选                                       | 后果                                                                                                               | 裁决                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Goal / Task / Step 三层结构                    | 归因链断裂，验收#1/#8/#12 失去类型层强制                                                                           | 留                           |
| `rootGoalId`（Goal 实体字段）                | 树语义取消后 Goal 无需携带；运行会话 id 由事件/存储/API 层持有（恒等于 goalId）                                    | **已删（2026-09-17）** |
| `Goal.parent`（含 split/delegation 两型）    | 树语义取消；多意图/多 agent 结构整体移除                                                                           | **已删（2026-09-17）** |
| `Goal.permissionCeiling / budget`            | 治理上限仍按意图直接配置（无层级递减）                                                                             | 留                           |
| `Goal.rawPayload`                            | 转写忠实度审计失去原料                                                                                             | 留                           |
| `Goal.statement / sourceSpan`                | 切分决策不可回溯，转写忠实度不可比对                                                                               | 留                           |
| `Goal.kind: 'intake' \| 'work'`               | **无断裂**：可执行性由 status=active 判定；Goal 直接承载 rawPayload 与解析 Step                              | **取消（最小抽象）**   |
| `Task.goalId` 唯一归属                       | 验收锚定多义，反思反馈无法锚定条款                                                                                 | 留（编译期强制）             |
| `StepKind` 二分（deliberation / invocation） | **无断裂**：决策链三环节坍缩为字段（推理/回答/提议、执行/结果），按来源而非环节分类；字段可表达的不增设 kind | **二分（最小抽象）**   |
| Delegation 独立实体                            | **无断裂**：职能由委托事件 + Goal 字段（origin/budget/permissionCeiling）承担                                | **解散（D6）**         |
| IntentSlice 独立类型                           | **无断裂**：statement/sourceSpan 并入 Goal，解析归因由树表达                                                 | **坍缩（D7）**         |
| `children` / `siblingGroup` 反向字段       | **无断裂**：树语义已取消，无需反向字段（扁平模型天然无双重真相源）                                           | **不设**               |
| `parsedByStepId` 字段                        | **无断裂**：由根 Goal 树结构 + 事件流隐含                                                                    | **不设**               |

---

## 9. AGI 演化预测（本层）

| 组成                                          | 演化                             | 依据                                             |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| 解析/切分编排（runtime 管线）                 | 削薄 → 删除                     | 理解劳动被模型吸收（脚手架纪律）                 |
| 协商回路                                      | 频率趋零；不可逆目标保留签字仪式 | commit 是后果转移仪式，非纠错                    |
| 契约**内容**生产                        | 模型自撰，成本趋零               | 能力内化                                         |
| 契约**形式**（冻结、机械可判、ceiling） | 不变，且承压增大                 | 消费者是评估器/审批人/审计员，读不到模型内部状态 |
| 解析归因挂载（根 Goal）                       | 不变                             | 解析 Step 需要 Goal 可挂，是归因闭合的必要条件   |
| 三层结构（Goal 独立 + Task + Step）           | 不变                             | 归因完备性下限；不可逆性/责任归属是环境属性      |

**判断某段 Goal 层代码会不会被 AGI 淘汰的操作性判据**：问“它服务理解还是承诺”——服务理解的（解析编排、切分管线）设计上就该被删；服务承诺的（冻结、机械可判、审批锚点、治理上限）删它们等于删架构哲学。

---

## 10. 自检清单（本层）

1. Goal 扁平契约由类型测试锁定：不含 rootGoalId/parent；intent 直接产 Goal；
2. in-memory Goal 构造器跑通：单 Goal、多独立 Goal、system 触发等场景的规划与执行；
3. 类型系统上：无法构造缺三层 ID 的 Step、无法构造 `taskId` 指向多 Goal 的 Task；
4. 多 Goal 专项：同一运行会话（rootGoalId）的 Goal 集独立成败互不牵连，按运行会话投影/级联删除；
5. 从任意截断的事件流 + Goal/Task/Step 事实可重建一次运行的完整归因。
