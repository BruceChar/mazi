# 架构

> 事实来源：`README.md`（架构总览、分层依赖、仓库结构）、`docs/C3-goal-migration.md`（Goal 坐标系迁移收口）、`packages/runtime/src/prompts/agent-prompts.ts`、各包 `package.json` / `tsconfig.json`。

## 分层与依赖方向

```
apps/webui   Vue 3 生产界面（对话流 / Context / 审计 / 存储 / 设置）
apps/api     NestJS + Fastify，REST + SSE，会话 / 工作区 / 审批 / 目录 / 事件
    │
packages/runtime   执行实现：Goal 编排 · ToolGateway · 事件总线 · Provider 供给 · 目录计费
packages/provider  厂商适配：DeepSeek · pi-ai 适配器 · 模型发现 · 官方价目解析
packages/core      契约层（无实现依赖）：authz · gts · observability · permissions · usage · id
packages/libs      跨端共享类型（Goal 树投影等）
```

依赖方向单向向下：**契约层不依赖实现，实现不依赖界面**。改代码时先判断落点：
契约/类型进 `core`，厂商适配进 `provider`，编排与治理进 `runtime`，界面只消费 API 与共享类型。

### 依赖边（以 package.json 为准，非约定）

| 包 | workspace 依赖 | 说明 |
|---|---|---|
| `@mazi/core` | 无（`dependencies: {}`） | 契约层无任何运行时依赖 |
| `@mazi/libs` | 无 | 纯类型 |
| `@mazi/provider` | `core`（+ `@earendil-works/pi-ai`） | 厂商适配只向下依赖契约 |
| `@mazi/runtime` | `core`、`libs`、`provider`（+ `js-tiktoken`） | 同时 `files` 含 `builtin-skills`、`tasks`，并有 `bin: mazi-project-wiki` |
| `@mazi/api` | `core`、`libs`、`runtime` | 依赖 graph 见 `apps/api/tsconfig.json` references（core、runtime） |
| `@mazi/webui` | **仅 `libs`** | UI 不 import core/runtime——“界面只消费 API 与共享类型”由 manifest 强制，而非靠自觉 |

因此：给 webui 引入 `@mazi/core` 会破坏红线 5 的结构前提；`@mazi/runtime` 的 `files` 里带 `builtin-skills/`
意味着 Project Wiki 的技能脚本随 runtime 包发布，改 Wiki 模板要同时考虑打包产物。

## 模块职责

| 路径 | 职责 |
|---|---|
| apps/api | REST + SSE 面：会话运行、工作区、Goal 快照、审批、事件 SSE、模型目录与用量、存储、健康与配置热更新；`/api` 前缀 |
| apps/webui | 对话流（thinking → 工具 → 观察 → 文本）、实时指标、Context 装配投影、审计面板、存储面板、审批门、设置、工作区切换 |
| packages/core | 契约层：Goal-Task-Step 坐标系、权限三原语与派生规则、观测事件信封、provider 内容/工具/Usage 契约、usage |
| packages/provider | 厂商适配与模型发现、官方价目解析；可插拔 Provider 抽象 |
| packages/runtime | Harness 执行：Goal 编排、工具网关 11 阶段管线、事件总线、上下文装配与 Project Wiki / Context Lifecycle |
| packages/libs | 跨端共享类型（Goal 树投影等） |

## 执行坐标系

Goal（意图/委托）→ Task（可独立验收的子目标）→ Step（thinking / tool / observation）。
两条底线：归因链必须终止于 `origin.kind ∈ {human, system}` 的根 Goal；
委托边 `permissionCeiling` 与 `budget` 单调递减，唯一升权路径是人工审批。
`docs/C3-goal-migration.md` 记录了 Session/Turn/Step → Goal/Task/Step 的映射与旧路径删除过程
（core 已无 Session/Turn/Capacity 导出）。

## 设计不变量

> 每一步的「判断」由模型做出，每一步的「事实」由 harness 记录。

事件信封 = 四元组坐标 `{rootGoalId, goalId, taskId, stepId}` + `seq` 全序 + `prevHash/hash` 哈希链 +
`causedBy` 因果边 + `actor`；append-only、闭集 kind 注册，无 update/delete API。

## 数据流（局部）

- 请求：WebUI → `/api` → runtime 编排 → Provider 流式 → 事件总线 → SSE 回传 WebUI。
- 长任务：Session 运行落 Goal 树；Task 验收由机械 checks（final-answer / file-exists / git-has-commit 等）判定，
  失败标记 Task/Goal 失败并触发有界 replan。
- 项目知识：SessionEnd → API 后台队列 → runtime ProjectWikiService 计算增量计划 → 隐藏 Goal 维护 `wiki/`。

## Agent 提示注册表与配置覆盖

内置提示与配置覆盖的唯一事实源是 `packages/runtime/src/prompts/agent-prompts.ts`：

- `AGENT_PROMPT_IDS` 固定为 `main / default / coding / planner / executor / reviewer / researcher / intent / replan / iteration-analysis`；
- 解析优先级恒为「配置 > 内置默认」，空白值等价于未配置（回落到默认），`resolveAgentPrompt` 是纯函数，可每轮重新取用；
- 主执行面走 `resolveBaseAgentPrompt` 的 `main → default → 内置 GENERAL` 回退链，`default` 只在 `main` 未配置时生效，避免两份提示同时拼进上下文；
- 委派角色的默认系统提示（`packages/runtime/src/agent/roles.ts` 的 `defaultAgentRoles(overrides)`）
  同样取自该注册表（`prompts.<roleId>`），不再在角色定义里内联文案；
- `intent` / `iteration-analysis` 分别绑定 `GOAL_PARSER_PROMPT` 与 `TOC_ANALYZE_PROMPT` 模板，
  `replan` 绑定失败补救的规划约束。

配置链路：`settings.json` 的 `prompts` 段 → `RuntimeSettingsFile.prompts` → `loadRuntimeConfig` 的
`normalizeAgentPrompts`（过滤非法 id、非字符串、空白值）→ `RuntimeConfig.agentPrompts` → Harness 装配。
保存走 `saveRuntimeSettings` 的 `mergeAgentPrompts`：空白值删除该 id（恢复默认），其余 id 不受影响，
与 `goal` / `permissions` / `pricing` 的浅合并共存。

对外接口（`apps/api/src/agent/agent.controller.ts`）：`GET /api/agent/prompts` 返回
`AgentPromptView[]`（含 `defaultPrompt` / `override` / `effectivePrompt` / `source: 'config' | 'default'`），
`PUT /api/agent/prompts/:id` 保存、`DELETE` 恢复默认；写入后重建运行时，**新会话生效，运行中的会话保持钉版**。
`apps/webui/src/components/AgentSettingsPanel.vue` 以「系统提示」页签展示并编辑这些提示。

## 项目知识库

- v2 事实源是项目仓库内的 `wiki/`；旧版 `$MAZI_HOME/wiki` 快照只作兼容数据保留。
- `GET /api/wiki` 同时返回兼容字段和 `repository` 只读视图；后者包含 Markdown 文档、
  claims 状态、摘要计数与最近知识提交。
- WebUI 采用“文档导航 / Markdown 正文 / 状态与事实证据”三栏布局，窄屏改为纵向流。
- 从项目菜单进入 Wiki 时，WebUI 同时切换全局工作区，顶部栏显示当前 Wiki 项目路径。
- 项目 Session 结束后，API 将同步任务放入按 workspace 串行的后台队列；后台先追加
  `state/current.md > 会话活动`，再由隐藏 Agent 判断是否更新语义内容和 claims。
- 前台 SessionStart 只注入 wiki INDEX；系统提示明确禁止主动询问是否初始化、更新或补全 Wiki。
- Wiki 页的“初始化”和“更新”通过 `/api/wiki/init|update` 启动隐藏项目 Agent；
  `/api/wiki/operations/:id` 轮询后台状态、最近 60 条 trace 与心跳，完成后自动重新读取文档与 claims。
- 后台维护 Agent 只能使用只读工具和受限 `project_wiki`：`write_doc` 仅能替换
  `wiki/**/*.md`，script 模式仅能调用 wiki.py 的维护子命令；初始化/更新完成和失败都写入会话活动。
- update 以最近 wiki checkpoint、git diff 和 current status 反查 evidence，只核验受影响 claims，
  不完整重读项目。
- Wiki 页在 KPI 下方展示完整 `state/current.md`；有效/待核验 KPI 可打开事实与 evidence
  明细；右侧独立订阅后台 Goal SSE，显示 reasoning/text stream、工具参数与输出、审批操作。
- 剩余 Wiki 工作只有 `docs/TODO.md`「项目 Wiki（后续）」三项：模型摘要 provider 接入
  （`wiki.summaryModel` / `createLlmSummarizer`，设计见 `docs/项目wiki设计.md` §7.3/§12）、
  graph-wiki 类插件（图谱 sidecar + 新工具面）、跨项目检索 / 历史版本链回滚。

## 待办与 Roadmap 入口

- 未做的产品功能只在 `docs/TODO.md` 维护：用户行为追踪、Provider 监控面板、模版功能、项目 Wiki（后续）。
- README §13 Roadmap 只是部分重述，且两份清单并不等价：
  - 重叠：Provider 监控面板、模板功能；
  - README 独有：评估深化、策略生态、多Agent编排、知识库、Agent监督；
  - 仅 `docs/TODO.md` 有：用户行为追踪、项目 Wiki 三项后续；
  - README 已将项目 Wiki 标记为「✅ 已实现」，不要把 Roadmap 当 Wiki 待办来源。
- 源码与 `wiki/` 中的 `TODO` 命中多为 Wiki 骨架模板文本与 Agent prompt 文案，**不能用源码 grep TODO 代替待办清单**。

### 产品清单之外的进行中/待排期工作

回答「还有哪些没做」时，除 `docs/TODO.md` 还要查下面四份文档；它们各自维护不同类型的未完成项：

| 文档 | 内容 | 交付状态 |
|---|---|---|
| `docs/runtime/AHF_RUNTIME_MEMORY_IMPLEMENTATION_TASKS.md` | 45 个 `MEM-*` 任务：P0 安全底座、P1 抽取/人格/认知画像、P2 检索与遗忘、`MEM-EVAL-*` 评测 | 文档自述「待排期」，实现侧无对应代码 |
| `docs/core/AHF_CORE_AUTHORIZATION_V4.md` | 权限系统 v4：两模式、来源链/目标链、硬闸、沙箱三件套、疲劳指标 | 文档自述「设计待评审，未实现」；实现仍是 v2/v3 语义 |
| `docs/runtime/AGENT_P0_P3_IMPLEMENTATION_PLAN.md` | P3-A MCP Adapter / P3-B RL-ready Trajectory / P3-C 奖励与数据集评估 | 文档自述「P3 尚未开始」 |
| `docs/runtime/AHF_PROJECT_CONTEXT_LIFECYCLE.md` §18 | 7 项待决策（行区间 evidence、多分支 checkpoint、packet rerank、……） | 未决 |

### 清单勾选状态不可全信

部分文档正文已宣告完成，但条目仍留 `[ ]`：`docs/P2-provider-switch.md` 第 40–46 行、
`docs/C3-goal-migration.md` 第 34–35 行。判断这些项时应以正文结论与提交号为准，
不要把它们计为待办。此外 `docs/TODO.md` 末尾存在字面 `\n` 而非真实换行，编辑前先修正。
