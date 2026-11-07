# Runtime Task Planning 与失败信号（P0 修复）

> 状态：已实现（2026-11-07）
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
  ├─ 异步 triage（goal-parser → route + goals/constraints → 语义/机械条款）
  └─ 立即返回（不等 triage，保持创建请求低延迟）
executeGoalTree
  ├─ await 尚未落地的 triage（上限 TRIAGE_TIMEOUT_MS；失败/超时按 fallback 继续）
  ├─ 重新加载 Goal（含 triage 追加的条款与 route）
  ├─ generateTaskPlan(goal, tools, sessionContext, history) → LLM Task Planner
  │    └─ 失败/被拒 → 回退单 Task（MVP），并写 plan.invalid
  ├─ runGoalTree：拓扑序逐 Task 执行；Task 之间注入前置结果
  └─ 每 Task：executeTask → verifier（机械 + 可选语义 judge）→ 失败时 replan（受限次数）
```

**不变量**：规划只能基于已落库的契约；triage 完成前不得生成计划。

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

## 5. 验收（与 P2 机械检查联动）

- 机械检查词表见 docs/core/AHF_CORE_GTS.md「机械检查词表（v2）」：
  `final-answer` / `no-failed-steps` / `file-exists` / `file-contains` /
  `git-has-commit` / `command-output-contains`。
- 需要人判/模型判的条款保持 `semantic`；未接 `SemanticJudge` 时一律 `unchecked`，不冒充通过。
- Task 验收范围来自规划时的 `Task.acceptance.conditions`（规划前置契约完整后即包含全部条款）。
- **验收失败不再算运行成功**：Task 机械验收 `passed=false` 时 Task 置 `failed`，
  `GoalRunResult.ok` / `goal.ended` / `Goal.status` 一并记为失败（aborted 仍保持可恢复）。
- **默认连续处理（replan）**：项目会话未显式注入 replan planner 时，失败会触发一次有界 LLM Replan
  （`createLlmReplanPlanner`，最多 `maxReplans` 次）：只补剩余工作、保留已完成 Task，然后继续执行；
  Replan 被拒绝或次数用尽才终止。失败分类账同时记录验收失败。

## 6. 测试

- `packages/runtime/test/task-planner.test.ts`：history 段、截断、多 Task 拆分规则。
- `packages/runtime/test/tool-executor.test.ts`：pipefail、sd no-op 检测。
- `packages/runtime/test/contract-negotiation.test.ts` / `acceptance.test.ts` / `verifier.test.ts`：结构化 check 与机械判定。
- `packages/runtime/test/task-planner-runtime.test.ts`：runtime 注入 history 后 planner 输入正确。

## 7. 后续（P1，待定）

接入 LLM `SemanticJudge`（建议按 Task 批量判定，避免每条款一次模型调用）；
对 `uncertain` 的验收结果不视为通过，必要时追加判定或 replan。
