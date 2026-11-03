# Agent 能力实现状态

> 本文记录计划图、权限、审计链、上下文快照、持久记忆和可迁移 bundle 的当前实现边界。
> 设计目标仍见 `README.md`、`docs/context_design.md` 与 `docs/core/`。

## P0 基础版（2026-11-02）

- **评测 Harness**：并入 runtime 的 eval 模块（`packages/runtime/src/eval`，原 `@mazi/eval`），包含任务 schema、30 个分级任务、离线 suite runner、工具准确率/接管率/Token/成本/延迟指标和失败归因。
- **会话自动评测**：普通 Session、恢复运行和 AB 臂结束后，从 Goal/Task/Step 与事件事实自动投影 Session Eval；结果落 `session_evaluations`，不向 Trace 回写派生值。
- **个人长期记忆**：增加 `PersonalMemoryService`，支持显式写入、模型候选、确认、纠正、deprecated/tombstone、内容去重、版本、项目关联和混合召回评分。
- **项目黑板**：新增 `ProjectBlackboardService`，使用独立 SQLite 文档保存项目目的、架构、状态、已完成项、问题、决策、下一步、证据和源指纹。
- **项目恢复**：项目内新会话注入黑板摘要和按需 `blackboard.read`；运行结束增量更新黑板，源指纹变化只标记复核，不自动全量重建。
- **API**：新增 `/api/memory` 治理接口、`/api/eval/tasks|runs` 评测接口（运行记录落
  `mazi.db`），以及
  `/api/projects/blackboard(+reconcile)` / `/api/projects/:id/blackboard(+reconcile)` 项目黑板接口。
- **WebUI**：新增 Eval Dashboard（全局/项目/会话）；个人记忆治理并入用户中心，项目黑板通过
  `GET /api/wiki` 并入原项目 Wiki，支持查看结构化知识、证据、版本与源漂移检查。

P0 当前仍为基础版：评测任务环境 fixture、真实在线数据集、记忆向量语义索引和黑板章节自动语义重写仍属于后续增强。

## P1 基础版（2026-11-02）

- **PromptPack**：增加默认 coding/research/data/memory/security/general 能力包，按 projectId、项目标签、任务类型、工具需求、风险与显式选择确定性匹配；L0 核心指令常驻，L1 只暴露索引，L2 只注入命中的模块，并受 1400 token 总预算约束。
- **SuperAgent**：请求级识别任务类型、风险、项目、PromptPack、Planner、Verifier 及记忆/黑板计划；决策通过 `superagent.decision` 和 `prompt.pack.selected` 留痕，不改变工具权限。
- **独立 Verifier**：`IndependentVerifier` 复用机械验收，并支持注入语义 Judge；输出 passed/failed/uncertain、逐条款结果、证据和失败分类。Verifier 不修改计划、不调用工具、不能自批。
- **失败归因**：覆盖 model/planning/tool_selection/tool_execution/context/memory/policy/environment/system；Verifier 结果通过 `verification.completed` 留痕，失败账本增加 `category`。
- **API**：新增 `/api/agent/prompt-packs` 管理、`/api/agent/preview` SuperAgent 预览和 `/api/agent/verifier` 信息；会话创建支持显式 `promptPackIds`，但仍受最小匹配和权限隔离。

P1 当前边界：PromptPack 当前状态与删除状态持久化在 `mazi.db`，历史版本档案和更细粒度归因仍待增强；
默认不内置校准 LLM Judge，需要外部注入。
- **WebUI**：SuperAgent、Planner 和 Verifier 不占主导航；PromptPack/角色模板与运行模式在
  设置页的 Agent 分类中维护，实际编排由 Harness 自动执行。

## P2 基础版（2026-11-02）

- **动态 Replan**：Verifier/Executor 失败后由可注入 `ReplanPlanner` 提出新 DAG；harness 保留已完成 Task，校验冻结契约、权限、预算、依赖和重复计划，限制最大 Replan 次数并记录 `plan.revised` / `replan.rejected` 与计划 diff。
- **多 Agent 角色**：内置 planner/executor/reviewer/researcher，可配置模型、工具、系统提示和权限上限。
- **委托治理**：SQLite delegation edge、父权限/预算单调递减、未知角色与预算溢出拒绝、最大委托深度。
- **并行与 handoff**：`delegate` 工具可一次提交多个子 Agent，并行执行独立子 Goal，结果沿工具 observation 回传；角色级工具、模型、Prompt 和预算在子会话生效。
- **审计**：`delegation.started/completed/rejected` 事件和 `/api/agent/sessions/:id/delegations` 委托边查询。

P2 当前边界：ReplanPlanner 需要宿主/模型侧注入，尚无默认 LLM Replanner；Agent Role 当前状态与删除状态
已持久化到 `mazi.db`；`memoryPolicy: isolated` 已建模但尚未强隔离上下文。
- **WebUI**：Replan 与委派不提供独立操作页；相关 diff、拒绝原因和 delegation edge 作为
  Harness 审计事实存在于 Trace 数据中，由 Eval 派生层聚合。
- **Lab**：AB 对照实验和固定 Benchmark 回归收进同一 Lab 的两个子集；两者都不再作为
  Trace 页签或 Session Eval 主入口。

## 已落地

| 能力 | 实现位置 | 当前语义 |
| --- | --- | --- |
| 分层 Task 图 | `packages/runtime/src/gts/plan-graph.ts` | 模型/调用方提交 `PlannedTask[]`，harness 编译 Task DAG；执行前校验环、孤儿依赖、权限上限、预算、工具供给和验收条件。 |
| 拓扑执行与恢复 | `packages/runtime/src/strategy/goal-strategy.ts` | Task 按稳定拓扑序执行；旧版本 Task 在 resume 时归一化验收字段并继续使用原 `taskId`。 |
| 工具权限与参数分类 | `packages/runtime/src/tool-gateway/` | `git` argv 进入命令分类器；HTTP 写方法切到 `net.send`；runtime 未注入审批 seam 时 gated 调用 fail-closed。 |
| 动态工具注册 | `packages/runtime/src/tool-gateway/registry.ts` | `registerTool/unregisterTool` 修改下一运行快照；已开始的运行固定工具版本与 digest。 |
| 可回滚文件副作用 | `packages/runtime/src/effects/effect-store.ts` | 显式声明且参数含 `path` 的文件写工具在执行前快照，支持 SQLite journal 和逆序恢复。shell/git 等任意命令不声称自动可回滚。 |
| 审计链 | `packages/runtime/src/events/event-bus.ts` | 每个 root goal 生成 `seq/prevHash/hash`，审批结算以 `causedBy` 指向请求事件；可独立验证并定位篡改。 |
| 上下文快照 | `packages/runtime/src/harness/context-manager.ts` | 记录 `epochId/prefixVersion/prefixHash`；窗口压力下压缩完整 assistant/tool 轮并 bump epoch。 |
| 持久记忆 | `packages/runtime/src/memory/store.ts` | SQLite 保存 user/workspace/project/conversation/task 作用域记录、provenance、TTL 与 tombstone。 |
| 偏好同步 | `SessionsService` + WebUI | 用户设置随会话创建同步为 T1 confirmed preference；后续用户/工作区召回通过 SQLite 复用。 |
| 可迁移 bundle | `packages/runtime/src/memory/transfer.ts` | 版本化 JSON bundle + SHA-256 checksum；记忆与 audit trail 分域保存。 |
| P0 评测 | `packages/runtime/src/eval` | 30 个任务、指标聚合、失败归因、Runtime 轨迹适配 |
| P0 个人记忆 | `packages/runtime/src/memory/personal-memory.ts` | 确认/纠正/墓碑、去重、项目关联和查询相关召回 |
| P0 项目黑板 | `packages/runtime/src/blackboard` | 结构化项目状态、增量更新、新会话注入和源漂移检测 |
| P1 PromptPack | `packages/runtime/src/prompts` | 项目/任务/工具/风险确定性匹配，L0–L2 渐进注入与预算 |
| P1 SuperAgent | `packages/runtime/src/agent` | 请求级 Planner/Verifier/PromptPack/记忆/黑板选择 |
| P1 Verifier | `packages/runtime/src/verifier` | 独立机械验收、语义 Judge seam、uncertain 与失败归因 |
| P2 Replan | `packages/runtime/src/gts/replan.ts` | 有界计划修订、保留已完成 Task、diff 与重复计划检测 |
| P2 Multi-Agent | `packages/runtime/src/agent/delegation*` | 角色、委托边、并行扇出、权限预算校验和 handoff |

## API

多 Task 计划可随创建会话请求提交：

```json
{
  "input": "检查、修改并验证项目",
  "plan": {
    "tasks": [
      { "key": "inspect", "title": "检查代码", "requiredTools": ["rg"] },
      {
        "key": "edit",
        "title": "修改代码",
        "dependsOn": ["inspect"],
        "requiredTools": ["sd"]
      }
    ]
  }
}
```

验收条件通过 `acceptanceConditionIds` 绑定 GoalContract；省略 `goalId` 时使用本次 root goal。

新增端点：

- `GET /api/eval/sessions`：查询由真实 Trace 派生的全局/项目/会话评测。
- `GET /api/eval/sessions/:id`：查询单次 root goal 的派生评测。
- `POST /api/eval/sessions/reconcile`：从已有 conversation → root goal → Trace 回填评测。
- `GET /api/eval/tasks`：读取 30 个 P0 Benchmark 基线任务。
- `POST /api/eval/runs`：运行指定 Eval Task 并返回报告；运行中、完成和失败状态均落 SQLite。
- `GET /api/eval/runs` / `GET /api/eval/runs/:id/report`：查询运行和完整报告。
- `GET /api/wiki`：项目 Wiki 复合视图（Wiki 快照、变更日志、项目黑板）。
- `POST /api/wiki/reconcile`：从项目 Wiki 入口执行项目知识源漂移检查。
- `DELETE /api/agent/roles/:id`：删除 Agent Role，并以 disabled 记录持久化。
- `GET /api/sessions/:id/effects`：读取副作用 journal。
- `POST /api/sessions/:id/rollback`：逆序恢复可逆文件副作用。
- `GET /api/sessions/:id/portable`：导出记忆 + 本会话审计链 bundle。
- `POST /api/sessions/:id/portable/import`：校验 checksum 后导入记忆；不会把 audit trail 注入召回事实。
- `GET /api/events/:id/verify`：校验事件哈希链。

## 仍需继续

- 模型自动生成计划提案尚未替代调用方显式 plan；当前是“模型可提议、harness 强校验”的接入口。
- 语义验收仍标 `unchecked`，独立 LLM verifier 尚未接入。
- 动态工具注册目前为进程内注册表，重启后从静态配置重建。
- 自动回滚只覆盖可识别的文件路径副作用；外部发布、支付、邮件和任意 shell 命令仍需人工审批，不能撤销已发生的外部事实。
- PromptPack 与 Agent Role 当前只保存最新状态；如需回滚或比较历史配置，还需追加版本表。

## Headless / API 支持矩阵

| 能力 | Headless/API 状态 | 仍需宿主提供 |
| --- | --- | --- |
| Eval Task / Run / Report | 支持，运行历史和完整报告持久化 | 模型 Provider、任务所需工作区与外部 fixture |
| Session Eval | 普通会话、恢复运行、AB 臂自动派生并持久化 | 语义质量仍需 Semantic Judge/人工标注 |
| 个人长期记忆 | 支持增删查改、确认、纠错、迁移与召回 | 用户身份解析策略 |
| 项目黑板 | 支持读取、对账、会话自动更新与注入 | 高质量章节重写仍依赖模型/Harness |
| PromptPack / SuperAgent | 支持注册、列表、预览和运行期选包；当前/删除状态持久化 | 历史版本档案 |
| 独立 Verifier | 支持机械验收、失败归因和事件查询 | 校准后的 Semantic Judge |
| Dynamic Replan | Runtime 与审计事件支持 | `ReplanPlanner` 注入；没有默认 LLM Replanner |
| 多 Agent 委托 | 支持角色注册/删除、权限/预算校验、并行 handoff 和 edge 查询 | 角色历史版本档案 |

## 分层边界

```text
Trace / Audit / Verifier      原始事实层：发生什么、证据是什么
            ↓ 投影
Session Eval                  派生业务层：一次运行表现如何
            ↓ 聚合
Eval Dashboard                全局 / 项目 / 会话趋势

Lab
├─ AB Experiment              受控干预对比
└─ Benchmark                  固定任务回归
```

Session Eval 与 Dashboard 不重新采集事实；它们只读取 Trace、Verifier、成本和事件。
Benchmark 使用独立固定任务集，不伪装成真实会话质量趋势。

## Web 信息架构

- 用户资产：用户中心（画像、记忆、问题、行为链、账本、用户设置）。
- 项目资产：项目 Wiki（项目知识黑板、状态快照、变更日志、证据）。
- 单次事实：Trace / Audit。
- 派生业务：Eval Dashboard。
- 受控实验：Lab（AB Experiment、Benchmark）。
- Harness 内部机制：SuperAgent、Planner、Verifier、Replan、Delegation；只在设置中维护模板和模式。

## 验收门禁

1. 低权限不能通过 `git commit/push` 或 HTTP POST 绕过审批。
2. 无效计划在执行任何工具前被拒绝。
3. 中断恢复不新建重复 Task，并保留原 Step 历史。
4. 可逆文件工具回滚后内容哈希恢复；不可逆命令明确拒绝自动回滚。
5. 同一 epoch 内上下文 prefix hash 不变，压缩后 epoch 增长。
6. 新进程可从 SQLite 召回用户/工作区记忆。
7. bundle checksum 或 audit head 被修改时导入/导出失败。
8. 审计事件被修改后 `verify` 返回 `AUDIT_TAMPER_SUSPECTED`。
