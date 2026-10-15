# 项目 Wiki 设计（Project Wiki v1.0）

> 一句话：把「项目最新状态」沉淀成 $MAZI_HOME 下的一份人读快照，新会话开始即注入；会话内每次写项目文件，追加一条『时间 | 改动』条目。
> 目标：**新会话零重读获取项目状态**，不再每次从头扫全仓库。
> 状态：待确认（对齐稿）。确认后按「测试先行 → 实现 → 每步 commit」推进。

---

## 1. 背景与问题

- 会话开始时模型对项目一无所知，只能靠工具反复扫仓库（rg/fd/cat）重建状态，付出大量 token 与轮次，且每次会话重复支付。
- 已有 Context 设计（docs/context_design.md）解决了「状态外置 + 决策相关注入」，但没有**项目级**的状态锚点：项目结构、模块职责、进行中的工作、近期改动散落在代码与 git 历史里。
- 会话对项目的改动也没有沉淀：换一个会话，上一个会话「改了什么功能」不可见。

## 2. 对齐结论（本轮已与用户确认）

| # | 决策点 | 结论 |
| - | ------ | ---- |
| 1 | 功能归属 | **mazi 产品功能**：runtime 实现，API 暴露，WebUI 可查看 |
| 2 | 存储根 | **`$MAZI_HOME/wiki/<项目名>/`**（MAZI_HOME 缺省 `~/.mazi`） |
| 3 | 目录内文件 | **单文件**：`wiki.md`（状态快照 + 内嵌变更日志）。逐次原始写记录不另落盘，复用既有 tool_call step 审计 |
| 4 | 写入者 | **混合**：harness 确定性捕获（不遗漏）+ 模型生成功能级摘要（可读性） |
| 5 | 捕获范围 | **写工具逐次记录 + 回合末兜底**（把 bash/sd/git 等间接写入补上） |
| 6 | 新会话读取 | **自动注入快照**（token 受限）+ **`wiki.read` 工具**按需读全文 |
| 7 | 事件格式 | `- <时间> \| <功能级改动>`，**不下沉到文件**（如「新增项目 wiki 读取与上下文注入」） |
| 8 | 快照刷新 | **阈值 + 会话结束**：变更累计 ≥ 10 条 或 会话结束 → 刷新状态快照；变更日志只追加 |
| 9 | 交付范围 | **runtime + API + WebUI** 三层 |
| 10 | 架构分层 | **runtime 事实/契约层 + 技能策略层 + 插件扩展层**（见 §2.1） |
| 11 | 技能交付 | **用户级技能模板**（`docs/templates/skills/project-wiki/`，经 `/api/capabilities` 创建；不违反 能力包规范 §8 SK-5） |

### 2.1 分层与边界（为什么 runtime 层不可省）

本仓库 Skill 规范（docs/能力包规范.md §1/§2/§7）明确：Skill 是 **SKILL.md 文本资产**，不注册新工具、不改工具面/权限、不订阅事件；新工具 / 私有数据面 / 机械约束归插件或 MCP server。据此分三层：

| 层 | 归属 | 承担 | 不承担 |
| -- | ---- | ---- | ------ |
| 事实/契约层 | runtime（本设计主体） | 写工具捕获、回合末兜底 diff、`时间 \| 改动` 日志（append-only）、存储/原子写/项目名治理/预算截断、新会话注入、`wiki.read`/`wiki.update` 两个稳定工具名、`WikiSummarizer` 策略插槽 | 摘要口径与文风、图谱/检索 |
| 策略层 | 用户级 Skill（模板见 §11.1） | 何时刷新、快照分区口径、功能级摘要写法、审查清单 | 无法保证「每次写入必有记录」「新会话必然注入」 |
| 扩展层 | 插件 / MCP server（本期不做） | 图谱、向量检索等新工具与新数据面；数据落 `$MAZI_HOME/wiki/<项目名>/graph/` sidecar | 不得改写 wiki.md 的日志区 |

结论：**两条硬需求只有 runtime 层能保证**——「写工具事实」只有 harness 观测得到，「必然注入」只有 context 层做得到；技能层负责质量与可移植，插件层负责重型引擎。三者通过 §9/§11.1 的契约配合：日志区仅 harness 追加、快照区可被模型/技能/插件写、工具名稳定。

## 3. 目标 / 非目标

**目标**

1. 新会话开始时自动获得项目状态快照（结构、模块职责、进行中的工作、最近改动），预算内注入。
2. 会话内对项目文件的写入（工具直写与间接写入）都会沉淀为一条功能级变更记录，格式为『时间 | 改动』。
3. wiki 可被人直接阅读（markdown），也可被工具/API/WebUI 读取。
4. 全部副作用发生在 $MAZI_HOME，工作区只读（不污染被管理的项目仓库）。

**非目标（本期不做）**

- 跨项目检索、wiki 全文检索/向量召回。
- 团队共享/远端同步（wiki 不随项目 git 提交）。
- 历史版本链与回滚（先保证 append-only 变更日志 + 原子写）。
- 多进程并发写同一项目 wiki 的强一致（进程内串行；跨进程仅做重试与最后写入胜出）。

## 4. 存储布局与文件格式

### 4.1 布局

```
$MAZI_HOME/wiki/
  index.json                 # 可选：项目名 → { 工作区, 最近更新 } 索引（API 列表用）
  mazi/
    wiki.md                  # 单文件：状态快照 + 变更日志
    wiki.md.bak              # 损坏/超限时的上一版备份（按需生成）
  mazi-3f9a/                 # 同名项目冲突时追加 4 位 hash
    wiki.md
```

### 4.2 wiki.md 结构（单文件）

```markdown
# mazi 项目 wiki

> 项目：mazi ｜ 工作区：/Users/bruce/nodejs/mazi ｜ 最近更新：2026-10-16T02:13:40+08:00 ｜ 会话：01J...

## 项目概览
（一句话定位 + 技术栈 + 运行方式）

## 结构与模块
- apps/api：REST 服务（sessions/conversations/goals/experiments/…）
- packages/runtime：Harness 运行时（gts/harness/memory/tool-gateway/…）
- packages/core：权限与治理原语（authz/ledger/…）

## 模块职责
（关键模块做什么、不做什么）

## 进行中的工作
（当前迭代、未完成项、已知坑）

## 约定与注意
（文档优先、测试先行、每步 commit、$MAZI_HOME 语义等）

## 变更日志
<!-- append-only；harness 只追加，不改写历史行 -->
- 2026-10-16 02:13:40 | 新增项目 wiki 的读取、注入与变更记录
- 2026-10-16 02:31:05 | 修复会话结束后快照未刷新
```

- **状态快照区**（`## 变更日志` 之前）：可被模型整体重写。
- **变更日志区**（含 `## 变更日志` 标题）：**只追加**，harness 不得改写或删除既有行；写入时先按标题定位插入点。
- 时间用本地时区 `YYYY-MM-DD HH:mm:ss`（人读）；文件头部的「最近更新」用带时区 ISO 串（机器读）。

## 5. 项目标识

- 项目名 = 工作区目录 basename（`/Users/bruce/nodejs/mazi` → `mazi`）。
- 冲突处理：`index.json` 中记录 basename → 工作区绝对路径。若同名但不同路径：
  - 首次占用该名字的项目保留 `mazi`；
  - 后来者在名字后追加工作区路径的 4 位短 hash（`mazi-3f9a`），并写入索引。
- 随心聊（未选项目）同样以实际工作区（`freeChatWorkspace`）解析项目名，不特殊处理。
- 工作区为空/不可用时：禁用 wiki（记 warn），不影响会话执行。

## 6. 模块划分（packages/runtime/src/wiki/）

| 文件 | 职责 |
| ---- | ---- |
| `naming.ts` | 项目名解析、重名 hash、`wikiDir()/wikiFile()` |
| `store.ts` | 读写单文件：解析/渲染状态快照区与变更日志区、原子写（临时文件 + rename）、损坏恢复、追加条目、进程内互斥 |
| `writer.ts` | 运行时写路径：写工具成功后记录 pending 事件；回合末合并兜底 diff；生成条目并追加 |
| `summarizer.ts` | 把 pending 原始事实 + 本回合用户请求/助手结论，交给模型生成 1–3 条功能级条目 / 重写快照；失败时确定性降级 |
| `injector.ts` | 生成注入片段（快照 + 最近 N 条变更），按 token 预算截断 |
| `index.ts` | 对外导出 `WikiService`（供 runtime / API 复用） |

集成点（最小改动）：

- `packages/runtime/src/paths.ts`：新增 `HOME_WIKI_DIR = 'wiki'`、`MaziPaths.wikiDir`，`ensureMaziDirs` 创建。
- `packages/runtime/src/harness/runtime.ts`：
  - `executeGoalTree` 入口：读取快照 → 注入（见 §8）；
  - `onStep` 路径：识别写工具成功 → `wikiWriter.record(...)`（§7.1）；
  - 回合收尾（RoundRunner.finishRound / runGoalTree 回调）：`wikiWriter.flushTurn(...)`（§7.2、§7.3）。
- `packages/runtime/src/gts/goal-executor.ts`：仅在既有 `invoker.invoke` 返回处暴露「工具名 + 参数 + 成功/失败」，不改执行语义。
- 工具注册：新增内置工具 `wiki.read` / `wiki.update`（沿用既有 tool 定义与 capability 映射；`wiki.update` 归 `fs.write.workspace` 同类，走审批策略）。

## 7. 捕获与写入

### 7.1 逐次捕获（写工具直写）

- 写工具白名单（capability 兜底判定）：`fs.write` / `sd` / `shell.run` / `git`（仅当 args 含写语义）等；判定顺序：工具名白名单 → 工具 capability 含 `fs.write.*` → 工具参数含路径且命令含重定向/写入算子。
- 每次成功写入记一条 pending：`{ ts, tool, paths[], diffStat? }`；失败/被拦截的不记（可记入调试日志）。
- 变更路径过滤：仅记录工作区内、且不在忽略集（`node_modules`、`.git`、`dist`、`.turbo`、`.pnpm-*`）的路径。

### 7.2 回合末兜底（间接写入）

- 会话开始建立工作区轻量快照：**统一使用「相对路径 + size + mtime」索引**（忽略集同 §7.1，条目上限 20000）。理由：git 仓库与非 git 工作区行为一致、无 git 依赖；`size` 变化对新建与内容改动都敏感。git 历史仍由 `git` 工具按需查询，不参与兜底。
- 回合结束再取一次，对比得到 added/modified/deleted 列表，与 §7.1 pending 合并去重 → 得到「本回合真实改动集」。
- 兜底仅补事实，不重复记条：同一路径同回合只产生一条功能级条目。

### 7.3 条目生成（功能级）

- 有改动才触发一次摘要调用（无改动零成本、零模型调用）。
- 输入：合并后的改动集（路径按顶层模块聚合）+ 本回合用户请求 + 助手最终答复要点 + 既有「进行中的工作」。
- 输出：1–3 条 `功能级` 描述，落到 `## 变更日志`：`- 2026-10-16 02:13:40 | 新增项目 wiki 的读取、注入与变更记录`。
- **不写文件名**；必要时用模块粒度括注（如「（runtime/API）」）。
- 条目文本由 **`WikiSummarizer` 策略插槽**生成：默认 `TemplateSummarizer`（确定性、零模型调用、保证必有记录）；需要更好文风时注入 `createLlmSummarizer(complete)`（模型输出 JSON 数组，解析失败自动降级模板）。
- 降级：摘要调用超时/失败/输出不合规 → 用确定性模板兜底（`更新了 N 个模块：runtime、API`），保证记录不丢。
- 技能层不重复记账：runtime 已保证事实记录，`project-wiki` 技能的职责是**快照口径**；只有发现 runtime 漏记时才用 `wiki.update` 追加条目。
- 变更日志保留上限：默认 500 条，超出时把最旧的 N 条折叠为一行汇总（`—— 更早 M 条变更已折叠 ——` 之上汇总为 1 行），避免文件无限膨胀。

## 8. 新会话读取与注入

- 时机：`executeGoalTree` 开始（每个 Goal 树会话一次），读取 `wiki.md` 快照区 + 最近 10 条变更。
- 位置：追加到 system prompt 尾部（`systemPromptWithSkills` 之后），标题 `## 项目 wiki（<项目名>，更新于 …）`，并附一句读取指引：「需要更完整历史时调用 `wiki.read`」。
- 预算：默认 ≤ 1500 token（约 6000 字符）；超限按 概览 > 进行中的工作 > 最近变更 顺序截断，并标注「（已截断，完整内容见 wiki.read）」。
- 首次会话（wiki 不存在）：不注入空片段，改为注入一句「本项目尚无 wiki；如有结构性改动请在收尾时刷新 `wiki.update`」。
- 注入内容视为**项目事实**，但属于模型可写来源 → 注入面治理（脱敏、长度上限）沿用 ContextManager 既有 hook 管线。
- 片段拼接顺序：基础 system prompt → Skill 目录 → Feature 片段 → **项目 wiki 快照**（wiki 最后，靠近决策点）；wiki 缺失时只注入一句提示。

## 9. 工具

| 工具 | 语义 | 权限 |
| ---- | ---- | ---- |
| `wiki.read` | 读当前项目 wiki：`{ section?: 'snapshot' \| 'log' \| 'all', limit?: number }` → `{ project, path, updatedAt, content }` | 只读，免审批 |
| `wiki.update` | 模型主动更新：`{ snapshot?: string, entries?: string[] }`；快照整体替换，条目只追加 | 归写能力，按既有策略审批 |

## 10. API（apps/api）

| 方法 | 路径 | 返回 |
| ---- | ---- | ---- |
| `GET` | `/api/wiki?workspace=<abs>` | `{ project, path, workspace, updatedAt, snapshot, entries: [{ ts, change }] }` |
| `GET` | `/api/wiki/list` | `[{ project, workspace, updatedAt, entries: number }]`（来自 index.json + 目录扫描） |

- 缺省 `workspace` = 当前选中工作区（`ApiRuntimeService.selectedWorkspaceRoot`）。
- 无 wiki → `200` + `{ project, entries: [], snapshot: null, empty: true }`（不报错，前端显示空态）。
- 控制器注册进 `apps/api/src/app.module.ts`，测试放 `apps/api/test/wiki.controller.test.ts`（与既有 `*.controller.test.ts` 同风格，用 in-memory/Memory 存储，不依赖真实 $MAZI_HOME）。

## 11. WebUI（apps/webui）

- 新增只读面板 `WikiPage.vue`（沿用现有 `LedgerPage.vue` / `BehaviorPage.vue` 的页面骨架与样式变量）：
  - 头部：项目名、工作区、最近更新时间、wiki 绝对路径；
  - 主体：状态快照（markdown 渲染，沿用项目内现有渲染方式）+ 变更日志时间线；
  - 空态：暂无 wiki，并提示「本会话产生写入后将自动生成」。
- 入口：侧边栏（Sidebar）在项目会话下显示「Wiki」；数据来自 `GET /api/wiki`，客户端状态加到 `apps/webui/src/api.ts` 与 `types.ts`。
- 不做编辑（本期只读）。

### 11.1 技能模板（用户级，非内置）

- 模板文件：`docs/templates/skills/project-wiki/SKILL.md`。随仓库分发的是**模板**，不落 `builtin-skills/`，符合 能力包规范 §8 SK-5「核心零领域」。
- 安装：复制到 `$MAZI_HOME/skills/project-wiki/SKILL.md`，或用 `POST /api/capabilities` 新建 + `POST /api/capabilities/project-wiki/mount` 挂载。
- 职责：快照分区口径、功能级摘要写法、何时刷新、审查清单；只用既有工具 `wiki.read` / `wiki.update`（Skill 不注册新工具）。
- 与 runtime 的配合：runtime 保证「每次写入必有记录」并负责注入；技能负责「快照与措辞质量」，不重复记账（避免同一改动出现两条）。
- 插件扩展（本期不做）：graph-wiki 一类引擎把图谱数据放 `$MAZI_HOME/wiki/<项目名>/graph/`，工具面按插件/MCP 设计另行登记；wiki.md 的日志区始终由 harness 独占。

## 12. 配置（settings.json 的 `wiki` 段，全部可选）

| 键 | 默认 | 说明 |
| -- | ---- | ---- |
| `enabled` | `true` | 总开关；关闭后不注入、不记录 |
| `injectBudgetTokens` | `1500` | 注入预算 |
| `snapshotThreshold` | `10` | 累计变更条数达到即刷新快照 |
| `logLimit` | `500` | 变更日志保留条数 |
| `summaryModel` | 未设置 | **预留**：模型摘要 provider 的模型选择；本期条目文本默认走确定性模板（§7.3），注入 `createLlmSummarizer` 后消费 |

## 13. 并发与一致性

- 单 Runtime 内：同一项目 wiki 的读改写走进程内串行队列（`WikiService` 持有 Promise 链）。
- 落盘：写临时文件 + `rename` 原子替换；追加时 read-modify-write，冲突重试 3 次，仍失败则记 warn 并放弃本次（不阻断会话）。
- 多进程（如实验 runtime 与主 runtime 同时写）：退化为最后写入胜出；索引文件用同样的原子写。**本期不引入文件锁依赖。**

## 14. 异常与边界

| 场景 | 行为 |
| ---- | ---- |
| $MAZI_HOME 不可写 | 记 warn，wiki 静默禁用，不影响会话 |
| wiki.md 损坏/无法解析 | 备份为 `wiki.md.bak`，以「空快照 + 保留可解析的日志行」重建 |
| 工作区不可用/为空 | 禁用 wiki（warn） |
| 非 git 工作区 | 兜底走 mtime/size 索引 |
| 单回合海量写入（>200 文件） | 兜底索引分层聚合（按顶层目录），条目仍限 1–3 条 |
| 摘要模型不可用 | 确定性模板降级 |
| 会话被 stop/abort | 以 stop 前已有的 pending + 兜底 diff 收尾，尽力写一条 |

## 15. 验收与测试清单（测试先行）

**runtime（`packages/runtime/test/`）**

- `wiki-store.test.ts`：项目名解析与重名 hash；追加条目只动日志区；快照替换不破坏日志；原子写；损坏恢复；日志上限折叠；token 预算截断顺序。
- `wiki-writer.test.ts`：写工具成功 → pending 一条；同回合重复路径去重；无写入不触发摘要调用；bash 间接写入被兜底 diff 捕获；摘要失败走模板降级；阈值触发快照刷新；会话结束触发刷新。
- `wiki-inject.test.ts`：新会话 system prompt 含快照与「最近变更」；超预算截断标记；wiki 缺失时不注入、给出提示句；`enabled=false` 不注入。
- `wiki-tools.test.ts`：`wiki.read` 分区读取；`wiki.update` 快照替换 + 条目追加 + 权限映射。
- `wiki-runtime-integration.test.ts`：新会话 system prompt 含 wiki 快照；模型调用 `fs.write` 后回合收尾落一条『时间 | 改动』；无写入的会话不产生条目。

**API（`apps/api/test/`）**

- `wiki.controller.test.ts`：有 wiki / 无 wiki（空态）/ 非法 workspace / list 聚合。

**WebUI**

- `apps/webui/test/wiki-page.test.ts`：空态渲染；有数据时的快照与时间线条目渲染。

**端到端手动验收**

1. 清空/备份 `$MAZI_HOME/wiki/mazi/`，开新会话让它改一个源文件 → 检查 `wiki.md` 出现一条『时间 | 改动』；
2. 关闭会话再开新会话（不提供任何上下文）→ 直接问「项目现在什么状态」→ 回答应命中快照信息且不触发全仓扫描；
3. WebUI 打开项目 → 能看到快照与变更日志；
4. `pnpm lint && pnpm test` 全绿。

## 16. 里程碑与改动文件清单

| 里程碑 | 内容 | 主要文件 |
| ------ | ---- | -------- |
| M1 | 本设计文档确认 | `docs/项目wiki设计.md`（已提交） |
| M2 | runtime：命名/存储 → 捕获 → 摘要 → 注入 → 工具（测试先行） | `packages/runtime/src/paths.ts`、新增 `packages/runtime/src/wiki/*`、`harness/runtime.ts`、`config.ts`、`configs/config-io.ts` |
| M2d | 分层落地：设计文档分层章节 + 用户级技能模板 | `docs/项目wiki设计.md`、`docs/templates/skills/project-wiki/SKILL.md` |
| M3 | API：只读接口 + 测试 | `apps/api/src/wiki/*`、`app.module.ts`、`apps/api/test/wiki.controller.test.ts` |
| M4 | WebUI：只读查看页 + 入口 + 测试 | `apps/webui/src/components/WikiPage.vue`、`App.vue`、`Sidebar.vue`、`api.ts`、`types.ts`、`apps/webui/test/*` |
| M5 | 文档收尾：README 文档地图/AGENT 约定 + 端到端验收 | `README.md`、`docs/TODO.md`（如适用） |

每个里程碑独立 commit；每个里程碑的测试先于实现落地。

## 17. 已确认与后续可选

**已确认（2026-10-16 对齐）**

1. 逐次原始写记录只存在于既有 tool_call step（mazi.db / 事件流）；wiki.md 只保留功能级条目（单文件）。
2. 条目格式 `- 时间 | 功能级改动`，必要时带模块括注（如「（runtime/API）」），不写文件名。
3. 架构分层：runtime 事实/契约层 + 用户级技能策略层 + 插件扩展层（§2.1）。
4. 技能以**用户级模板**交付，不破例内置（符合 SK-5）。
5. WebUI 入口放侧边栏（项目会话下显示），只读。

**后续可选**

- 模型摘要 provider 接入（配置 `wiki.summaryModel`，实现 `createLlmSummarizer`）。
- graph-wiki 类插件：图谱 sidecar + 新工具面（独立设计文档）。
- 跨项目检索 / wiki 历史版本链。
