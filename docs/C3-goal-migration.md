# C1：Session/Turn/Step(+capacity) → Goal/Task/Step 迁移映射（core 坐标系）

> 依据：docs/core/AHF_CORE_GOAL.md v0.5（归因坐标系）；OBSERVATION v1.0 事件流后续衔接。
> 状态：C2 契约已落地（goal-coordinate.ts，9661701）；本文件固化映射与执行顺序。

## 1. 术语/对象映射

| 旧（将被删除）            | 新（goal-coordinate）                          | 说明                                                        |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| Session(rawIntent+goal) | root Goal(kind=intake, origin) + work Goal   | 一次输入 = 一棵 Goal 树；intake 承载解析/切分 Step（D4）     |
| Turn                     | Task（taskId + goalId 唯一锚定验收，D3）        | Task.acceptance 锚定 goal.contract 条款                      |
| Step（turnId/sessionId） | Step（taskId + goalId；rootGoalId 沿链派生）    | thinking/tool_call/observation 三环节保留（D 决策链）        |
| SessionAggregate/TurnCheckpoint | 预算/终止并入 Goal/Task 字段；续传走事件 seq（OBS） | 存储与恢复语义随后续事件流卷落地                             |
| capacity.ts（Capacity 等） | 治理上限挂 Goal；执行供给走 TOOL/AUTH 卷        | capacity.ts 最终删除（用户裁决点 2 见下）                    |

## 2. 字段衔接（两处待裁决，答复前 C3 按“默认”执行）

1. 旧 GoalContract 的 allowedTools/requiredTools/strategyHints/loopMode：
   **默认（待 TOOL 卷）**：作为 Goal 附加字段保留在迁移桥（goal-coordinate.contract 之外挂 runtime 层 GoalExt），
   planner/executor 迁移期读取 GoalExt，避免执行语义丢失；TOOL-GATEWAY 卷落地后再收敛。
2. 存储：**默认并存过渡**——新表 goals/tasks/steps（含 rootGoalId/parent/goalId/taskId），旧表仅读不写，
   全部迁移完成后删除旧表与旧代码路径。

## 3. 执行顺序（每阶段独立提交，保持每包 build 0 错误）

- [x] C2：goal-coordinate.ts 契约 + 法律校验纯函数（9661701）
- [ ] C3a runtime memory/sqlite：goals/tasks/steps 表 + 读写（rootGoalId/parent 投影）
- [ ] C3b runtime planner：plan(Goal) → Task[]（intake 切分最小实现 + 兄弟校验）
- [ ] C3c runtime executor：executeTask(task, goal)（Step 归属 taskId/goalId；requestRound 复用）
- [ ] C3d runtime strategy/full-loop + HarnessRuntime：Goal 树驱动（react-only/多 Task）
- [ ] C3e usage/observability/recorder 适配（rootGoalId/goalId 事件四元组收敛见 OBS v1.0）
- [ ] C3f runtime 测试迁移（goal-coordinate/内存/plan/executor/harness）
- [ ] C4 apps/cli/api/webui：Conversation 保存 goal 树；展示 goal/task/step 层级
- [ ] C5 删除 session.ts/turn-contract.ts/capacity.ts 与旧列/旧事件；pnpm check 全绿

## 4. 校验/回归

- 法律校验纯函数零 mock（goal-coordinate.test 已覆盖链/环/预算/越权）
- 每次提交保持受影响包 tsc 0 错误；C5 前旧包仅共存（build 不删导出）
## 5. C5 依赖墙与推荐顺序（round 10 实测）

**不能直接删**：legacy 模块被当前运行路径引用，直接删除即破坏 51 文件/248 用例的全绿基线：
- core：session.ts / turn-contract.ts / capacity.ts / goal.ts(旧) / planner.ts / policy.ts / tool.ts —— 旧
  HarnessRuntime 路径（runtime.ts 的 Session 方法、executor、planner、usage、api sessions 等）仍依赖；
- runtime：executor/planner/full-loop 旧路径、sqlite-store 旧表、user-profile recorder、usage cost。

**推荐顺序（保持每步全绿）**：
1. goal 执行补全：executeTask 接入工具循环 + Policy（复用旧 Executor 的 policy/tools 加工），使 Goal 路径
   具备真实工具闭环能力；
2. HarnessRuntime 双轨数据源：api/cli 默认切换 runGoalSession；旧 Session 方法仅留兼容（标记 deprecated）；
3. 存储迁移：legacy sessions/turns/steps 旧表 → goal_nodes/goal_tasks/goal_steps 数据搬运脚本 + 断旧读；
4. core 删除：session.ts/turn-contract.ts/capacity.ts/旧 goal.ts 等（先清 core index 引用），goal-coordinate
   公共导出放开；
5. runtime 删除旧 executor/planner/sqlite 旧表/user-profile 旧事件；api conversations 视图改 goal 树；
6. 全仓 pnpm check 恢复全绿（目标验收）。

**验收对照**：C5 完成 = @mazi/core 不再有 Session/Turn/TurnContract/Capacity 导出；goal-coordinate 经 index 公共导出；
全仓 build + vitest + biome 全绿。
