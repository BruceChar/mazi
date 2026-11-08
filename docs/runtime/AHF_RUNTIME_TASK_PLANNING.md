# Runtime Task Planning 与失败信号（P0 修复）

> 状态：已实现（2026-11-09 修订）
> 关联：docs/core/AHF_CORE_GTS.md（契约与机械检查词表）、docs/web/观测看板设计.md（plan 可观测）、用户行为流设计无关。
> 背景故障：run `01M6TJJ57BV20XRC2SS71V0QNX`（用户输入 `A`）只生成 1 个泛化 Task、
> 17 条语义条款从未判定、模型把文件内容当最终回答即被 `final-answer` 收尾。

## 1. 目标

1. **规划前契约完整**：Task Planner 看到的 Goal 必须已经包含 triage 的 route 与全部条款。
2. **规划输入有上下文**：planner 能看到同一 Conversation 的最近对话（短输入如 "A" 才有意义）。
3. **计划可观测**：`plan.created` 记录 Task 标题与依赖，UI/复盘可审计 DAG。
4. **失败信号不被吞掉**：管道失败与"写工具静默 no-op"必须表现为工具失败。

## 2. 流程与顺序

```
createGoalSession
  ├─ 冻结基线契约（2 条机械条款）
  ├─ 发出 intake，并安排 triage（goal-parser → route + goals/constraints → 语义/机械条款）
  └─ 创建请求先返回（只用于让用户输入立即可见；不是与规划并行的执行主线）
executeGoalTree
  ├─ await 尚未落地的 triage（上限 TRIAGE_TIMEOUT_MS；失败/超时按 fallback 继续）
  ├─ 重新加载 Goal（含 triage 追加的条款与 route）
  ├─ route=direct 且带 answer → 记录直答终态并结束（不规划、不执行）
  ├─ generateTaskPlan(goal, tools, sessionContext, history) → LLM Task Planner
  │    └─ 失败/被拒 → 回退单 Task（MVP），并写 plan.invalid
  ├─ plan.created（计划先落定）
  ├─ executing
  ├─ runGoalTree：同步串行、拓扑序逐 Task 执行；Task 之间注入前置结果
  └─ 每 Task：executeTask → verifier（机械 + 可选语义 judge）→ 失败时 replan（受限次数）
```

**不变量**：Goal → triage → Plan → Task → Step 是一条同步串行状态机；规划只能基于已落库的契约，
triage 完成前不得生成计划，计划落定并发出 `plan.created` 前不得进入 `executing`。创建接口先返回只为
显示用户输入，不会让规划或执行另起异步主线。

### 2.1 直答零执行不变量（2026-11-09 修订）

- `route=direct` 表示模型判断该意图无需读取工作区、调用工具或产生副作用。非 resume 执行中，
  只要 `directAnswer` 非空，runtime 直接以该回答结束：不生成 Task、不生成 Step、不调用工具、
  不进入 Task Planner；Goal 落为 `succeeded`，`endedAt` 与 `goal.ended.summary` 记录直答终态。
- 直答内容仍是由 triage 模型产出的事实，不属于 harness 执行事实。若旧数据或异常分支同时存在
  Task/Step，UI 必须以 harness 执行事实为准展示完整树，不能因 `route=direct` 隐藏实际调用。
- `route=direct` 但 `directAnswer` 缺失/空白时不满足直答终态条件，继续走正常规划与执行。
- 直答没有 Task，`GoalRunResult.finalAnswer` 承载回答；Conversation 历史组装在无 deliberation
  Step 时回退读取该字段/`directAnswer`，避免下一轮丢失上一轮回答。
- `resume=true` 不把已存在的工作强行截断为直答；恢复路径继续复用已落库 Task/Step。

## 3. Task Planner 输入

- Goal：statement、route、contract.successConditions（含机械/语义）。
- `history`：同一 Conversation 最近轮次（旧→新，role=user/assistant），单条截断 1500 字符、
  总预算 4000 字符；planner prompt 末尾追加「最近对话」段。
- prompt 规则：多产物/多阶段必须拆多个 Task 并用 `dependsOn` 表达顺序；
  禁止把执行类目标塌缩成单个「检查/分析并给出最终回答」的 Task；仅简单目标允许 1 个 Task。

## 4. 失败信号

| 来源 | 旧行为 | 现行为 |
|---|---|---|
| shell 管道内失败（`cargo test \| tail`） | 管道末命令退出码 0 → ok | `bash -o pipefail`，任一命令失败 → 工具 error |
| 写工具静默 no-op（`sd` 模式未匹配仍退出 0） | ok，Step succeeded | 执行前后对比目标文件，内容未变 → `ok:false` |
| 工具失败 | Step error → 验收 failed → replan（受 maxReplans 限制） | 同上，信号不再被吞 |
| 管道下游提前关闭（`| head` 的 SIGPIPE，exit 141） | 被当作命令失败 | 视为正常结束（命令已执行；输出附 `SIGPIPE ignored` 提示） |
| `rg` 无匹配（exit 1） | 被当作命令失败 → 误触发验收失败/replan | 工具 spec 声明 `noMatchExitCodes:[1]` → `ok:true`，内容 `(no matches)`；exit 2 仍是真实错误 |
| `fd` 传入 glob（如 `*.md`） | 按正则解析报错 → 失败 | `globFlag:'--glob'`：含 glob 元字符且非法 regex 时自动加 `--glob`；合法 regex 语义不变 |

> 2026-11-08 修订：一次真实运行（`项目有代办吗`）中大量 `rg` 无匹配与 `fd *.md` 被误判为失败 Step，
> 触发 `no-failed-steps` 验收失败并进入 replan 循环。工具层现已显式区分「无结果」与「真实错误」，
> 避免 false-failure 驱动无意义 replan。

## 5. 验收（与 P2 机械检查联动）

- 机械检查词表见 docs/core/AHF_CORE_GTS.md「机械检查词表（v2）」：
  `final-answer` / `no-failed-steps` / `file-exists` / `file-contains` /
  `git-has-commit` / `command-output-contains`。
- 需要人判/模型判的条款保持 `semantic`；未接 `SemanticJudge` 时一律 `unchecked`，不冒充通过。
- Task 验收范围来自规划时的 `Task.acceptance.conditions`（规划前置契约完整后即包含全部条款）。
- **验收失败不再算运行成功**：Task 机械验收 `passed=false` 时 Task 置 `failed`，
  `GoalRunResult.ok` / `goal.ended` / `Goal.status` 一并记为失败（aborted 仍保持可恢复）。
- **默认连续处理（replan）**：项目会话未显式注入 replan planner 时，失败会触发一次有界 LLM Replan
  （`createLlmReplanPlanner`，最多 `maxReplans` 次）：只补失败 Task 的补救工作，保留已完成 Task，然后继续执行；
  Replan 被拒绝或次数用尽才终止。失败分类账同时记录验收失败。
- **计划代际（planVersion）与 replan 卫生（2026-11-08 修订）**：
  - 计划版本：初始计划 `planVersion=1`；第 N 次 Replan（`PlanRevision.revision=N`）产出的
    revision 内全部 Task `planVersion=N+1`。UI 据此只渲染当前计划，历史尝试保留在 Trace。
  - 保留剩余 Task：`ReplanRequest.remainingTasks` 携带当前计划中尚未执行的 Task（pending/active），
    Replan prompt 明确「必须保留、不要重复规划」；`createPlanRevision` 以同一 taskId 把它们原样带入新
    revision（失败 Task 的依赖重映射为本次补救 Task 的 id），只追加补救 Task，避免整段工作被重复规划。
  - 清理孤儿：应用 revision 时扫描 store，删除所有「不在新计划内、`status=pending` 且零 Step」的 Task
    （含更早 revision 遗留），失败/已执行尝试保留不动（审计证据不丢）。
  - `GoalStore.deleteTask` 仅删 Task 行、不删 steps（调用方保证只对零 Step 的 pending Task 调用）。
  - 事件：`plan.created` payload 增加 `planVersion` 与 `tasks[{taskId,title,dependsOn,planVersion}]`；
    `plan.revised` payload 增加 `planVersion` 与完整 `tasks[{taskId,title,dependsOn,planVersion,status}]`，
    UI 无需等 timeline 刷新即可渲染修订后的计划。

## 6. 测试

- `packages/runtime/test/task-planner.test.ts`：history 段、截断、多 Task 拆分规则。
- `packages/runtime/test/tool-executor.test.ts`：pipefail、sd no-op 检测。
- `packages/runtime/test/contract-negotiation.test.ts` / `acceptance.test.ts` / `verifier.test.ts`：结构化 check 与机械判定。
- `packages/runtime/test/task-planner-runtime.test.ts`：runtime 注入 history 后 planner 输入正确。
- `apps/webui/test/exec-tree.test.ts`：只有“direct 且无执行事实”才隐藏契约/Task 树。
- `apps/api/test/sessions.service.test.ts`：无 deliberation Step 的直答可回填 Conversation 历史。

## 7. 后续（P1，待定）

接入 LLM `SemanticJudge`（建议按 Task 批量判定，避免每条款一次模型调用）；
对 `uncertain` 的验收结果不视为通过，必要时追加判定或 replan。
