# 渐进式 Workflow：节点、转移与装配

本文件定义 runtime 的节点式执行模型。目标：把「用不用规划」从全局布尔换成**候选节点 + 合法转移 + 数据前置条件**，复杂度由任务进展动态决定。

## 一、Node 是 interface，不是基类

理由：节点不该有共享状态与共享字段。基类会诱导「把预算/事件/日志塞进基类字段」，节点就不再可测。跨切面能力（记账、事件、超时）由 **runner 中间件**统一处理，节点只做一件事：读视图 → 返回 delta。

```ts
interface WorkflowNode {
    readonly id: string;
    readonly role: Phase;
    readonly priority: number;
    requires(state: WorkflowState): boolean;          // 数据前置条件
    run(state: WorkflowState, view: ContextView): Promise<NodeResult>;
}

interface NodeResult {
    delta?: Partial<WorkflowState>;   // 只写增量
    next?: Phase;                      // 正常转移，必须在合法转移表内
    terminal?: Outcome;                // 显式终止；优先于 next
}
```

节点之间**不直接调用**，只经 `WorkflowState` 通信；`next` 由 runner 校验后才生效。

## 二、相位与合法转移（typestate 的运行时等价）

```ts
type Phase = 'think' | 'act' | 'observe' | 'plan' | 'verify' | 'reflect';

const TRANSITIONS = {
    think:   ['act', 'plan', 'verify'],
    act:     ['observe'],
    observe: ['think', 'verify', 'reflect'],
    plan:    ['think', 'act', 'verify'],
    verify:  ['think', 'reflect'],
    reflect: ['plan', 'think'],
} as const satisfies Record<Phase, readonly Phase[]>;
```

- 编译期：`satisfies` 固定表结构；节点声明自己的 `role`，出边必须 ⊆ 表。
- 运行期：`assertTransition(from, next)`，越界直接抛。
- `Think → Think`、`Act → Act` 属于**非法转移**，表直接拦掉。
- `Think → Plan → Think` 是**合法但可能空转**，靠数据前置条件拦（见第三节）。

## 三、数据前置条件与进展不变量

| 节点 | requires 条件 |
| --- | --- |
| Plan | `host.plan` 存在，且（无计划 ∨ 无开放任务 ∨ `plan.staleBy === 'reflect'` ∨ `actedSincePlan > 0`） |
| Act | `host.act` 存在 |
| Observe | `pending.length > 0`（必须有待吸收的结果） |
| Verify | `awaitingVerify` ∨（验收标准非空 ∧ 无开放任务 ∧ `host.verify` 存在） |
| Reflect | `failures ≥ 2` |
| Think | 恒可用（最后兜底） |

谓词轴只判**数据是否就绪**；**能力是否装配**由工厂决定是否创建节点（`plan`/`verify` 缺失即不建）。把能力判断塞进 `requires` 会让同一条规则随装配漂移，例如「Verify 需要验收标准」在没有验收器时也恒真。

“Plan 之后必须消费一个任务才能再次 Plan”即 `actedSincePlan > 0`，这是防止 `Plan→Think→Plan` 空转的硬条件。

## 四、内置节点与统一方法

| 节点 | 实现 | 说明 |
| --- | --- | --- |
| `think` | `host.think` | 一次 LLM 推理：产出 toolCalls 或 final answer |
| `act` | `host.act` | 只执行工具，写出 `pending` 原始结果（可含多条 tool call） |
| `observe` | `host.observe` 钩子 + **确定性内置** | 先回注上下文，再把 `pending` → `facts`，逐条标注 ok/error，按 `maxFacts` 截断 |
| `plan` | `host.plan` | 产出任务清单；不可用则节点不进候选，自动退化为 think-act |
| `verify` | `host.verify`，缺省规则版 | 无验收标准时直接通过；有标准但无实现时不可用 |
| `reflect` | **规则内置** | 失败归因：计划存在 → 置 `staleBy='reflect'` 并 next=plan；否则 next=think |

`host.think` / `host.act` 是必需项；`observe` 钩子可选，缺省只做 facts 收敛；`plan` / `verify`
缺失即降级，不是开关。

## 五、流转与选择

runner 每步：

```
candidates = nodes.filter(n => TRANSITIONS[state.phase].includes(n.role) && n.requires(state))
next = candidates.sort(priority).first()
assertTransition(state.phase, next.role)
result = await next.run(state, view)
apply(delta); charge(usage)
```

`priority` 只在同一角色有多个执行器时用于挑实现；正常路径相位由上一节点的 `next` 指定。
首步固定由 Think 决策（否则 think→think 非法，Think 永远无法启动）。

所以「谁是兜底」不再是优先级，而是 `next` 的合法集合：Think 的出边包含 `act/plan/verify`，
失败≥2 时由 Reflect 节点（`failures ≥ 2`）被上一节点指向。

## 六、终止判定（只由 runner 说 done）

```
openTasks === 0
  ∧ acceptance.length === 0 ? 'done'
  ∧ verdict === 'passed'    ? 'done'
  ∧ verify 不可用           ? 'done-unverified'
```

终止枚举：`done / done-unverified / aborted-budget / aborted-no-progress / aborted-no-candidates / failed`。
摩擦层：步数/墙钟（硬保险丝）、无进展计数（连续 K 步 facts/openTasks/planVersion 均不变）、候选为空（立即终止）。

## 七、RunState 与 WorkflowState

```ts
interface RunState {       // 可持久化、可跨 lane 共享
    goalId; statement; plan?; facts; pending; acceptance; verdict; failures; usage;
}
interface WorkflowState extends RunState {   // 单个 loop 的视图
    phase; actedSincePlan; startedAt; handoff?;
}
```

- `RunState` 是事实与资源：计划、事实、待吸收结果、验收、失败数、用量。它是保存/恢复的单位，未来多 lane 共享的也是它。
- `WorkflowState` 是 `RunState` 快照 + 游标（当前相位、Plan 后执行计数、起点时间、点对点 handoff）。游标不持久化，恢复时重新从 `think` 进入。
- 节点只接收 `WorkflowState`；runner 在检查点把其中的 `RunState` 部分提交给 store，二者不共用可变引用。

## 七、上下文共享与 prompt 组织

```
[基座] 身份 / 全局约束 / 工具清单 / 任务简报     ← 所有节点一致，前缀缓存命中
[角色] 该相位要产出什么 schema、允许/禁止什么、失败如何表达
[工作集] 最近 K 条 facts、计划摘要、开放项、handoff  ← 每步变化，放在最后
```

节点拿 `ContextView`（字符串三段 + token 预算），不拿全量 transcript；事实存 `state.facts`，不进 prompt 原文。多模型由 `ModelBinding{role,providerId,modelId}` 绑定到执行器，缓存不跨模型，相邻节点尽量同模型。

## 八、初始化与装配

```ts
const nodes = createBuiltinNodes({ think, act, plan?, verify? });
const runner = new WorkflowRunner(nodes, { maxSteps, maxElapsedMs, maxNoProgress, maxFacts });
const { state, outcome, events } = await runner.run(initialState);
```

初始化顺序：构造节点 → 校验每个节点 `role` 合法 → 校验 `next` 合法（运行期再校验一次）→ runner 持节点表与限额。不经过 kernel/ports：节点是**编译期成员**，可运行期替换的只有 `host` 里的执行器（对应 ports 的能力注入）。

## 八点五、Step 归属与 Router 审计

Step 除 `kind`（deliberation / invocation）和 `role`（语义阶段）外，还记录真实执行归属：

```ts
Step.nodeRunId?: string;   // 实际节点执行 span，例如 act:<taskId>
Step.nodeId?: string;      // 例如 act
Step.nodeRole?: Phase;     // 实际节点角色
Step.agentRole?: 'planner' | 'reasoner' | 'router' | 'executor' | 'observer' | 'verifier' | 'reflector' | 'deterministic';
```

- `kind` 仍是 payload 与重放的判别式；
- `role` 只影响展示（Thinking / Acting / Observing）；
- `nodeRunId / nodeId / agentRole` 回答“这一步实际是谁执行的”；
- 旧 Step 缺省这些字段，消费方按 kind 优雅降级。

SuperAgent 的路由决策不进入 workflow 节点统计，但会落到 `Goal.routing` 与 `superagent.decision` 事件：

```ts
Goal.routing?: {
  taskKind; riskLevel; promptPackIds; plannerId; verifierId;
  loopMode: 'default' | 'dynamic' | 'direct';
  route?: 'direct' | 'workflow';
  routedBy: 'super-agent' | 'triage';
  reason: string[]; at: number;
}
```

Trace 面板有独立的「Router 决策」区，展示 route / loopMode、taskKind、risk、prompt pack、planner、verifier 与 `reason`，不依赖契约展开。直答路径也必须写入 `route:'direct'` 的 Router 审计；它没有 NodeRun，也不参与节点步数。

## 九、验收口径

1. 任意两步转移都合法（属性测试）；
2. 任意初始状态在 `maxSteps` 内终止，且 outcome ∈ 六种枚举；
3. Think→Think 无法选出；Plan→Think→Plan 在零执行时无法再次选 Plan；
4. 缺 `plan` 时永不进入 plan 节点，缺 `verify` 且验收非空 → `done-unverified`；
5. Observe 输出条数 ≤ maxFacts，且逐条保留 ok/error；
6. 节点代码不出现 `this.state` 之类共享字段（interface 约束的产物）。

## 十、不在本期范围

工具批并行、lane 并行、Join 节点、`TurnEngine` 整体替换。本期只交付节点契约、内置节点、runner 与测试；接入 TurnEngine 是下一步。
