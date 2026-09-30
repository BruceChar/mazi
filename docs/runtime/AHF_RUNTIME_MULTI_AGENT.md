# Runtime 多 Agent 抽象设计

**状态**：设计稿（待确认，确认后按文档优先 + 测试先行进入开发）

**范围**：packages/core（委托契约纯函数）+ packages/runtime（agent-roles /delegation/orchestrator / 扇出调度）+ apps/api & webui（多 Goal 会话与委托树视图）。

## 1. 背景与边界

### 1.1 现状（2026-09-17 扁平化后）



* Goal 实体**无&#x20;**`parent`**&#x20;/&#x20;**`rootGoalId`：user intent 直接产 Goal，Goal 相互独立，只挂下属 Task；「法律 1 归因链闭合」「法律 2 治理上限单调递减」随树结构一并取消（AHF\_CORE\_GTS.md §5/§6/§8）。

* `rootGoalId` 仅保留在**事件 / 存储 / API 层**作为运行会话 id（单 Goal 时恒等于 goalId）。

* 存储层 `goal_nodes` 已有 `root_goal_id` 列，但 `saveGoal` 目前硬编码 `root_goal_id = goalId`（每 Goal 自成根）。

* 执行层 `runGoalTree`（strategy/goal-strategy.ts）对 Goal 集**串行 for**，首个失败即停（代码注释已写明 "后续可扩展为任务组并行"）。

* 多意图现状：调用方显式拆成多个 Goal 会话，或在同一 Goal 内排多个 Task（Plan 图）。

### 1.2 多 Agent 需要什么

水平并行（多个独立 Goal 同时跑）与垂直分工（一个任务拆给多个专业 Agent 协作）都需要：



1. **运行会话内的委托关系**：谁派生了谁（归因），子 Agent 的结果如何回传。

2. **角色配置**：每个 Agent 可绑定不同模型 / 工具白名单 / 系统提示 / 治理上限。

3. **治理约束跨 Agent 传递**：子 Agent 权限、预算不能绕过父的治理边界。

4. **两种产生委托的途径**：规则驱动（确定性、可审计）与模型自主（模型提议、harness 收束）。

### 1.3 为什么不复活 Goal 树

扁平化的价值是「Goal 实体不含树字段、契约层零树依赖」；多 Agent 需要的委托关系属于**运行编排层**，不应回灌进 core 的 Goal 类型。因此本设计把委托关系放在**独立边存储**（delegation\_edges），Goal 实体保持扁平不变 ——**边是编排事实，不是 Goal 字段**。这与「rootGoalId 留在存储 / 事件 / API 层」的既有裁决同构。

**判别**：删掉边，会断裂「子 Agent 归因与治理传递」→ 留；删掉 Goal.parent 字段，无断裂（边已承担）→ 不设。

## 2. 概念边界

**Agent ≠ 新实体**：Agent = 一个可独立执行的 Goal（子树）**绑定一个角色**。角色（agent\_roles 注册表）定义 "以什么模型、什么工具、什么系统提示、什么治理上限去执行这个 Goal"。

**delegation ≠ Goal 字段**：委托关系是 `parent_goal_id → child_goal_id` 的有向边，落 `delegation_edges` 表。边携带角色、产生方式（rule | model）、治理（权限上限 / 预算份额）、归因（causedBy 事件 id）。

**orchestrator ≠ 常驻实体**：编排能力挂在运行时上：规则分解是 planGoalTree 的扩展；模型自主委托是 ToolGateway 里的一把 `delegate` 工具。两者共用同一委托边模型与校验，差异只在 "谁来产生提议"。

## 3. 数据模型

### 3.1 agent\_roles 注册表（runtime 配置级，非 core）



```
interface AgentRole {
  roleId: string;                        // 'planner' | 'executor' | 'reviewer' | 'research' ...
  label: string;
  model?: { providerId: string; modelId: string };   // 缺省继承会话模型
  tools: string[];                       // 工具白名单（透传 allowedTools）
  systemPrompt?: string;                 // 缺省 GENERAL_PROMPT
  defaultCeiling?: PermissionLevel;      // 缺省继承父 Goal 的 ceiling
  memoryPolicy?: 'inherit' | 'isolated'; // 缺省 inherit（见 §6.4）
}
```

### 3.2 delegation\_edges（存储层，新表）



```
CREATE TABLE IF NOT EXISTS delegation_edges (
  edge_id        TEXT PRIMARY KEY,
  root_goal_id   TEXT NOT NULL,          -- 运行会话 id（与 goal_nodes.root_goal_id 同源）
  parent_goal_id TEXT NOT NULL,
  child_goal_id  TEXT NOT NULL,
  role_id        TEXT NOT NULL,
  mode           TEXT NOT NULL,          -- 'rule' | 'model'
  permission_ceiling TEXT NOT NULL,      -- 子 Agent 执行上限（边不变量，见 §4）
  budget_share   TEXT NOT NULL,          -- JSON：BudgetAllocation（父 budget 的切分）
  caused_by      TEXT NOT NULL,          -- 产生本边的决策事件 id（rule=plan 事件；model=delegate 调用 stepId）
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_child ON delegation_edges(child_goal_id); -- 每 Goal 至多一条入边
CREATE INDEX IF NOT EXISTS idx_delegation_parent ON delegation_edges(parent_goal_id);
```

### 3.3 core 契约：委托校验纯函数（无实现依赖，零 mock）



```
// packages/core/src/delegation.ts（新增；index 导出）
export interface DelegationEdge { /* §3.2 的类型投影，不含存储细节 */ }
export interface DelegationValidationInput {
  edges: readonly DelegationEdge[];
  goals: readonly Goal[];            // 用于读取父 ceiling/budget 与子 ceiling
  roles: readonly AgentRoleRef[];    // 仅 roleId 集合（core 不依赖 runtime 实现）
}
export type DelegationViolation =
  | { code: 'no-incoming-edge'; goalId: string }          // 非根无入边
  | { code: 'root-not-human-or-system'; goalId: string }  // 根 origin 非法
  | { code: 'ceiling-raise'; childGoalId: string }        // child.ceiling > 父.ceiling
  | { code: 'budget-overflow'; parentGoalId: string }     // 兄弟 budget_share 之和 > 父 budget
  | { code: 'cycle'; goals: string[] }                    // 边图成环
  | { code: 'unknown-role'; childGoalId: string; roleId: string };
export function validateDelegation(input: DelegationValidationInput): DelegationViolation[];
```

校验规则（边不变量，等价于原法律 1 / 法律 2 在边层的重立）：



* **L1' 归因闭合**：除根外每个 Goal 恰有一条入边；根（无入边者）`origin.kind ∈ { human, system }`。

* **L2' 治理上限单调递减**：`child.permissionCeiling ≤ 父.permissionCeiling`；兄弟 `budget_share` 之和 ≤ 父 `budget`。

* **L3 审批终止于人类**（既有）：子 Agent 需要高于父上限的权限时，唯一路径 = 现有 approvals，委托校验不做升权。

* **无环**：边图 DFS 判环，杜绝 A 委托 B、B 又委托 A 的悬空委托。

## 4. 执行扇出（水平并行）

改造 `runGoalTree`（strategy/goal-strategy.ts）：串行 for → **扇出调度**。



* 同一运行会话（rootGoalId）下 `status === 'active'` 的 Goal 集，按 `concurrency` 上限并行执行；每个 Goal 独立 `executeTask`（独立 ContextManager / RoundRunner），天然支持不同 role → 不同模型。

* **失败隔离**：一个 Goal 失败不影响兄弟；`GoalRunResult.ok = outcomes.every(o => o.ok)` 语义不变（与现实现一致，只是不再首败即停）。

* **预算并发扣减**：并行下预算账本必须原子扣减（core/authz/ledger.ts 的记账走事务 / 串行队列），防止兄弟同时超额。

* **串行兜底**：`mode: 'sequential'` 保留现行为（依赖顺序、共享上下文的场景显式声明），缺省由 orchestrator 按边决定。

## 5. Orchestrator 双模式（垂直分工）

同一委托边模型，两种产生途径：

### 5.1 模式 A・规则驱动（确定性）

`planGoalTree` 扩展：输入 Goal + 契约条款 / 工具类别 → 输出 `{ goals, tasks, edges }`。



* 分解依据是**机械规则**：`goal.contract.successConditions` 条款数 > 1 且可分类 → 每条款一个子 Goal（role 按条款类型映射）；`forbiddenResources` 命中的工具类别 → 该子 Goal 降 ceiling。

* 确定性：同一输入必产出同一边集（可测、可审计、零 LLM 成本）。

* 不可分解输入 → 退化路径：单 Goal 直跑（现状不变）。

### 5.2 模式 B・模型自主（delegate 工具）

在 ToolGateway 注册 `delegate` 工具（走既有 11 阶段管线与权限检查）：



```
delegate({ statement, roleId, budget?, ceiling? })
```



* 模型在轮次内**提议**委托（与提议普通工具调用同构）；harness 在 ToolGateway 校验段执行 `validateDelegation`：


  * 通过 → 落 child Goal + delegation\_edge（mode='model'，caused\_by = 本 stepId），调度执行；

  * 违反 L2'（越权 / 超预算）→ 拒绝该调用，发 policy 事件，**不落边**；模型可改提议（降 ceiling / 预算）重试；

  * 子 Agent 需要升权 → 走既有 approvals（审批通过后放行，审批指认 `{ goalId, conditionId }` 不变）。

* 子 Goal 结束后，其 `GoalRunResult`（finalMessage + ok）作为 `delegate` 调用的 observation 回传父 Goal——**结果传递复用工具观察通道**，无需新消息类型。

> 模式 B 完整落在「模型生成假设（委托提议），harness 让假设可证伪（校验 + 落边 + 审计）」的分工判据内。

## 6. 结果传递与归并



* 水平：各 Goal 结果独立落 GoalStore，由运行会话（rootGoalId）投影归并 ——api 现有 `listGoalsByRoot` / 事件流天然支持。

* 垂直：父 Goal 的 reflect 阶段读取子 Goal 的 `GoalRunResult`（经 delegate observation 或 GoalStore 按边查询），汇总进父 Goal 的最终回答。

* **记忆**：`memoryPolicy: 'inherit'` 时，父 Goal 的 context 快照作为 child 的 ContextContribution 显式交接；`'isolated'` 时 child 只见自身轮次。默认 inherit（对齐现 runGoalTree 跨 Goal 共享记忆语义）。

## 7. 接线（代码落点）



| 层       | 落点                                            | 变更                                                         |
| ------- | --------------------------------------------- | ---------------------------------------------------------- |
| core    | `src/delegation.ts`（新增）+ `index.ts` 导出        | 纯类型 + validateDelegation，无实现依赖                             |
| runtime | `src/agent/agent-roles.ts`（新增）                | 角色注册表 + 查询                                                 |
| runtime | `src/agent/delegation-store.ts`（新增）           | delegation\_edges 读写（复用 goal-store 的 db）                   |
| runtime | `src/memory/goal-store.ts`                    | `saveGoal(goal, rootGoalId?)` 放开 root 参数（缺省 = goalId，兼容现状） |
| runtime | `src/strategy/goal-strategy.ts`               | runGoalTree 并行扇出 + concurrency + 失败隔离                      |
| runtime | `src/strategy/goal-planner.ts`                | 规则分解（模式 A）                                                 |
| runtime | `src/tool-gateway/builtin.ts` + permission.ts | 注册 `delegate` 工具（模式 B），校验接入 validateDelegation             |
| runtime | `src/harness/runtime.ts`                      | 多 Goal 会话入口（一次输入 → 多 Goal + 边）                             |
| api     | sessions/runs 控制器                             | 多 Goal 创建；timeline 增加委托树投影                                 |
| webui   | goal 树视图                                      | 显示 role / 委托边（父子连线）                                        |

## 8. 测试基线（验收契约，测试先行）



| 文件                                | 覆盖                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `delegation.test.ts`（core，零 mock） | L1'：非根无入边拒绝；根 origin 非法拒绝；L2'：child ceiling > 父拒绝、兄弟预算之和 > 父拒绝（等于 = 通过）；无环：A→B→A 拒绝；unknown-role 拒绝；合法边集通过 |
| `delegation-store.test.ts`        | 落边 / 查边 / 级联删除（随 deleteGoalTree）；唯一入边约束                                                                    |
| `goal-store-root.test.ts`         | saveGoal 带 root → listGoalsByRoot 归组；不带 root 行为不变（回归）；Goal 类型仍无 parent 字段（扁平不变量）                           |
| `orchestrator-fanout.test.ts`     | 水平：N 个独立 Goal 并行（并发上限生效、墙钟 < 串行和）；一 Goal 失败兄弟完成、ok 语义；并行预算原子扣减不超额；role 绑定生效（白名单外工具被 invoker 拒绝）            |
| `orchestrator-rule.test.ts`       | 规则分解确定性（同输入同边集）；条款→子 Goal 映射正确；不可分解→单 Goal 直跑退化                                                            |
| `orchestrator-delegate.test.ts`   | delegate 合法提议→落边 + 子 Goal + 结果回传；越权提议→拒绝且不落边、发 policy 事件；成环提议→拒绝；升权→审批阻塞→审批通过放行；事件回放可重建委托树（每节点可达根）         |
| `goal-path.test.ts`（回归）           | 现单 Goal 会话语义不变                                                                                             |

## 9. 实施顺序（每阶段独立提交，保持全绿）



1. core `delegation.ts` 契约 + `delegation.test.ts`（纯函数，零 mock）。

2. runtime 存储：`goal-store` root 参数 + `delegation-store` + 对应测试。

3. runtime `agent-roles` 注册表 + role 绑定透传 executeTask。

4. runtime 扇出：`runGoalTree` 并行（保留串行 mode）+ fanout 测试。

5. runtime Orchestrator 模式 A：规则分解 + 测试。

6. runtime Orchestrator 模式 B：`delegate` 工具 + 校验闭环 + 测试。

7. api /webui：多 Goal 会话 + 委托树视图；全仓 `pnpm check` 全绿。

## 10. 不做（YAGNI / 最小原则）



* **不复活 Goal.parent/rootGoalId 字段**：委托关系只在边层，core 契约零树依赖。

* **不做 peer-to-peer 网状 Agent**：委托保持树形有向边，归因与治理可机器判；网状是后续独立卷。

* **不做动态角色自举**：角色由注册表配置，模型只能选角色不能造角色（权限边界）。

* **不做 Agent 级自省 / 协商协议**：结果传递只经 delegate observation 与 GoalStore，不加新消息类型。

* **不做跨运行会话委托**：边只存在于同一 rootGoalId 内。