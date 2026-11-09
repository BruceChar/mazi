# Agent 角色管理与会话选择设计

> 范围：设置页自适应布局、Agent 板块分区、自定义 Agent 角色、会话内选择 Agent（含更好的替代交互）。
> 状态：设计方案，待评审后按 P0→P3 分期实施。

## 1. 现状诊断

### 1.1 设置页布局
- `SettingsPage.vue`：`max-width: 720px`、`padding: 32px 48px` 固定值，无断点；窄窗口下输入框（`.setting-input.wide { width:300px; max-width:48vw }`）与大段说明文本会挤压换行。
- 导航（`SettingsSidebar`）为纵向列表，窗口变窄时无横向降级方案，只能靠侧栏折叠。
- `AgentSettingsPanel` 全部纵向排列：模式说明卡 → PromptPack 表单 → 角色表单 → SystemPrompt 列表；三类表单共用 `grid-template-columns: 1fr 1fr`，移动端才降为单列，中小屏中间态没有适配。

### 1.2 Agent 板块概念混杂
| 现有块 | 实际职责 | 问题 |
|---|---|---|
| SuperAgent / Planner / Verifier 卡 | 运行期内部能力说明 | 只读，却和可编辑表单混排 |
| PromptPack 模板 | 按任务类型匹配的提示包 | 概念接近「角色」，用户分不清 |
| Agent 角色模板 | 委派角色（roleId/label/tools/prompt/ceiling） | 无 description、无模型、无图标、无启停 |
| SystemPrompt 配置 | 各 Agent 系统提示 | 与角色模板重复（角色也有 systemPrompt） |

### 1.3 会话侧
- 会话创建只透传 `goal`、`preferences`、`modelId`、`permission`；没有「用哪个 Agent」的入口。
- Agent 选择完全由 `SuperAgent` 按 PromptPack 自动匹配，用户不可见、不可覆盖。
- 角色注册 API 只有 `POST/GET/DELETE`，缺更新、启停、校验和使用情况。

## 2. 业界参考

| 产品 | 选择方式 | 关键做法 | 可借鉴点 |
|---|---|---|---|
| Claude Code Subagents | `--agent` 指定主 Agent；对话中「用 X subagent」显式调用；否则按 `description` 自动匹配 | 角色 = 名称 + 描述 + 工具 + 模型 + 指令；description 是路由契约 | 显式调用必须存在；描述写得越「动作化」自动路由越准 |
| GitHub Copilot Chat | 输入框底部 **agent picker**；`@agent` 语法；组织级 Agent 分组展示 | 选择器贴着输入框，当前 Agent 始终可见；支持分组与搜索 | picker + `@` 双通道；分组而非平铺 |
| Cursor | Composer 内 mode/model 选择 chip；Agents 面板管理并行 Agent；Auto 路由 | 选中项永远显示为 chip；Auto 是一等选项 | 会话内不改全局设置；Auto 默认 |
| ChatGPT / Codex | 会话级模型选择器（Default/具体模型），选择随会话保留 | 选择是**会话作用域**，不会污染其他对话 | 会话级钉版优先于全局默认 |
| LangGraph / CrewAI（框架侧） | 角色由代码/配置定义，运行期按图或顺序编排 | 角色与执行拓扑分离 | 角色定义归设置，编排归 harness |

**结论**：业界主流不是「每次让用户挑 Agent」，而是三层：
1. **Auto 为默认**（能力路由，用户零成本）；
2. **会话级钉版**（在 composer 里选一次，当前对话持续生效）；
3. **消息级显式覆盖**（`@agent` / 快捷命令，只影响本条）。

角色管理集中在设置页，角色定义的核心字段是 `name + description + instructions + tools + model + ceiling`，其中 description 同时承担「给用户看的说明」和「给路由器看的匹配依据」。

## 3. 设计方案

### 3.1 设置页 Agent 板块分区

改为 4 个子分区（二级 tab，窄屏降级为横向滚动 chip）：

| 分区 | 内容 | 说明 |
|---|---|---|
| **Overview** | 运行期能力只读说明（SuperAgent / Planner / Verifier / Replan）+ 当前默认 Agent | 只读卡，不再与表单混排 |
| **Agents（角色）** | 角色卡片栅格 + 新建/编辑抽屉；内置与自定义分组 | 主入口 |
| **Prompts** | 各 Agent 的系统提示（现有 SystemPrompt 配置） | 与角色解耦：角色引用提示 id，也可自定义覆盖 |
| **Packs** | PromptPack 模板（按任务类型注入） | 保留给高级用法，默认折叠 |

角色卡片展示：图标/颜色、label、`roleId`、description 一行截断、能力徽标（工具数、权限档、模型、内存策略）、「内置/自定义」「已启用/已停用」、被会话引用次数。
卡片操作：编辑、复制、启停、删除（被引用时改为停用并提示）。

**角色字段（在现有 `AgentRole` 上扩展，全部可选以兼容旧数据）**

```ts
interface AgentRole {
  roleId: string;              // 稳定 id，slug 校验
  label: string;
  description: string;         // 路由契约 + 用户说明（新增，建议必填）
  icon?: string;               // LineIcon 名称
  color?: string;              // 主题色 token
  category?: 'general' | 'coding' | 'research' | 'review';
  modelId?: string;
  tools?: readonly string[];
  systemPrompt?: string;       // 缺省引用 prompts.<promptId>
  promptId?: AgentPromptId;    // 新增：绑定系统提示配置
  defaultCeiling?: PermissionLevel;
  memoryPolicy?: 'inherit' | 'isolated';
  enabled?: boolean;           // 新增，缺省 true
  builtin?: boolean;           // 新增，内置角色不可删除只能停用
}
```

校验：roleId 唯一、slug 格式、label/description 非空、tools ⊆ 已注册工具、ceiling 不超过系统上限、promptId 必须存在。

### 3.2 会话内选择 Agent

**Composer 底部新增 Agent chip**，与 model / permission chip 同排，位置在 workspace chip 右侧：

```
[工作区 ▾] [Agent: 自动 ▾] [模型 ▾] [推理 ▾] [权限 ▾]        [发送]
```

菜单结构（复用现有 `.picker-panel` 样式）：

```
自动（推荐）           SuperAgent 按任务描述路由
── 我的 Agents ──
编码 Agent   workspace-write · 5 工具
审查 Agent   read-only
── 内置 ──
研究 Agent   调查与证据归纳
```

交互规则：
- **默认「自动」**：行为与现状一致，不改变任何执行路径。
- 选择后写入**当前会话**（conversation 级），刷新/切换会话仍保留；顶部会话标题旁显示 Agent 徽标。
- 选择即时生效于**下一条消息**，正在运行的 Goal 不受影响（钉版语义）。
- 输入框内 `@编码 Agent` 或 `/agent coding`：仅对**本条消息**覆盖，发送后 chip 回到会话级设置，并在消息气泡上标注「本条由 X 处理」。
- 权限收窄：候选角色 `defaultCeiling` 高于会话权限时置灰并提示「该 Agent 需要 workspace-write 权限」；工具取交集，不足时提示缺失项。
- 没有可用角色时显示「自动」+ 一行引导「在设置 → Agent 中创建角色」。

选择结果落点：`POST /api/sessions` 新增 `agentId`；会话记录新增 `agentId`；运行时 `createGoalSession` 新增 `roleId` 选项，按角色解析 systemPrompt / tools / ceiling / memory。

### 3.3 提示解析优先级（更新）

```
消息级 @agent 覆盖
  > 会话钉版 agentId
    > Auto 路由（SuperAgent 选中角色）
      > prompts.main / prompts.default
        > 内置 GENERAL
```

Agent 自身的提示不再以「角色存全文」为唯一依据，而是按 `PromptRef` 引用解析（见 3.8）：

```
inline 覆盖 > config[key] > system 默认[key] > 未命中（沿用主执行面基础提示）
```

未配置任何提示的角色行为不变：只使用主执行面基础提示。

### 3.4 审计与可解释性

- 新增事件 `agent.selected`：`{ roleId, source: 'picker' | 'mention' | 'auto', reason, ceiling, tools }`，落在 Goal 事件流。
- 运行详情面板展示「本次由谁执行、为什么」；Auto 路由展示 `description` 命中理由（沿用 SuperAgent trace）。
- 会话列表可按 Agent 过滤（后续）。

### 3.5 设置页自适应规则

| 断点 | 布局 |
|---|---|
| ≥1024px | 侧栏 220px + 内容区占满剩余宽度；设置卡片按 `columns: 520px 3` 自动分栏（1–3 列），Agent 面板 `column-span: all` 后内部左右分栏（左二级导航 184px + 右内容） |
| 768–1023px | 侧栏收窄 180px；角色卡 2 列；表单字段 2 列 → 1 列 |
| <768px | 导航改为顶部横向滚动 chip；内容 `padding: 20px 16px`；所有卡片单列；编辑改为全屏抽屉（`100dvh`） |
| <520px | chip 只显示图标 + 短标签；表单控件 100% 宽；保存按钮吸底 |

通用规则：
- 用 `clamp()` 替换固定 padding：`padding: clamp(16px, 4vw, 48px)`。
- 所有 `width: 300px` 类固定宽度改为 `flex: 1 1 220px; min-width: 0`。
- 长说明 `overflow-wrap: anywhere`；表单控件 `min-width: 0` 防溢出。
- 抽屉/弹层用 `max-height: min(80vh, 720px)` + 内部滚动，避免小屏超出。
- 触控目标 ≥ 36px；hover 态同时提供 `:focus-visible`。

### 3.6 更好的替代方案（推荐结论）

不建议做「每次新建会话强制选 Agent」的全屏选择器：增加摩擦，且多数任务 Auto 已够用。推荐 **Auto-first + 会话钉版 + 消息级 @覆盖** 三层结构，理由：
1. 与 Claude Code / Copilot / Cursor 的用户预期一致；
2. 不选也能用，选了可见、可解释、可回退；
3. 显式选择只影响会话，不污染全局配置；
4. 角色数量控制在 5–8 个、description 写得动作化，Auto 命中率最高——角色质量比选择器复杂度更重要。

### 3.7 Agent 技能挂载

角色除了「用什么模型、能碰哪些工具」，还需要「带哪些技能」。约定：

- `AgentRole.skillIds?: readonly string[]` 是**该 Agent 的默认技能集**，只对这个角色生效，不改变全局挂载（`$MAZI_HOME/skills.json`）。
- 解析顺序：**运行级显式 `skillIds`（实验/恢复） > 角色技能 ∪ 全局挂载 > 全局挂载**。后两者取并集去重、按 id 排序，技能只做加法，不改变工具面与权限。
- 角色未配置 `skillIds`（或空数组）时行为与现状完全一致：沿用全局挂载。
- 委派时角色技能随子 Goal 一起下发（`createGoalSession({ skillIds })`），因此子 Agent 的技能边界独立可解释。
- 设置页：角色编辑面板新增「技能」多选（数据来自 `GET /api/capabilities`，只读取已发现技能，不改变挂载状态）；角色卡展示「技能 N」，空选即「跟随全局挂载」。

边界：技能是提示与流程资产，不授予新工具；角色的 `defaultCeiling` 仍是唯一权限收窄点。

### 3.8 Prompt 目录与引用（Agent 的提示来源统一）

**结论：Prompt 条目是唯一文本来源，Agent（角色与内联 Agent）只持有 `PromptRef` 引用；`PromptRef` 在每次委派 / 每轮调用前解析，配置改动对下一次调用生效，运行中的会话保持钉版。**

#### 现状问题

- 提示库是**固定 id 白名单**（`main / default / coding / planner / executor / reviewer / researcher / intent / replan / iteration-analysis`），配置只能覆盖这 10 个键，不能新增。
- `AgentRole.systemPrompt` 存的是**全文**：内置角色在 Runtime 构造时把 `prompts.<roleId>` 解析成文本并固化，自定义角色在 SQLite 里存整段文本。改提示库不会影响已存在的角色，副本越多漂移越大。
- 同一个 Planner 有两套身份：流水线内联调用的 `prompts.planner`，和委派角色 `planner` 的 `systemPrompt`。两者名字相同但来源、能力边界、生命周期都不共享。
- 角色面板只有自由文本框，无法「从系统或配置提示列表中选择」。

#### 目标模型

**Prompt 条目（PromptEntry）是唯一文本来源，Agent 只持有引用，不持有文本。**

```ts
interface PromptEntry {
    key: string;                     // 稳定引用键：[a-z][a-z0-9-]{1,47}
    label: string;
    description?: string;
    scope: 'builtin' | 'custom';     // builtin 随代码发布；custom 存在 settings.json
    body: string;                    // 生效文本（builtin 默认或 custom 文本）
    defaultBody?: string;            // builtin 的出厂文本，用于「恢复默认」
    version: number;                 // custom 每次保存 +1；builtin 随应用版本
    readonly: boolean;               // builtin 不可删除，只能被覆盖
}
```

规则：

- `builtin` 条目即现有的 10 个系统提示 id，不可删除，可被同 key 的 custom 文本覆盖（与今天 `prompts` 语义一致）。
- `custom` 条目由用户在「系统提示」分区新建，key 不得与 builtin 冲突（冲突视为覆盖，不新建）。
- `settings.json` 的 `prompts` 从「固定 id 的类型」放宽为 `Record<string, string>`；旧文件天然兼容，空字符串仍视为未配置。

#### PromptRef

```ts
type PromptRef =
    | { kind: 'system'; key: string }   // 指向 builtin 条目（可被配置覆盖）
    | { kind: 'config'; key: string }   // 指向 custom 条目
    | { kind: 'inline'; text: string }; // 角色自带全文（兼容旧 systemPrompt）
```

`AgentRole` 新增 `promptRef?: PromptRef`，`systemPrompt` 保留为兼容字段：

- 有 `systemPrompt` 且无 `promptRef` → 归一化为 `{ kind: 'inline', text: systemPrompt }`；
- 两者都没有 → 无提示片段，沿用主执行面基础提示（与现状一致）；
- 两者都有 → 以 `promptRef` 为准，`systemPrompt` 仅作展示兜底，保存时清空（避免双来源）。

内置 6 个委派角色一律改为 `{ kind: 'system', key: roleId }`，不再固化文本。这样改 `prompts.planner` 后，`planner` 角色下一次委派即生效，无需编辑角色。

#### 解析与拼装

```ts
resolvePromptRef(ref, prompts) => { text, source: 'inline'|'config'|'system', key }
```

- 委派角色：`inline` > `config[key]`（非空） > `system[key]`（builtin 默认或覆盖） > 空（不追加）。
- 内联 Agent（intent / planner / replan / iteration-analysis）：不允许空，解析不到配置就回落到内置默认；仍保持 `agentPrompt(id)` 的单轮调用形态。
- 拼装位置不变：解析结果作为 `promptFragment` 追加在基础提示之后（append 语义）。本阶段不引入 replace 语义，避免 Planner 的 JSON 输出契约与主提示冲突的处理复杂度。
- 解析时机：**每次委派 / 每轮内联调用前**解析引用；会话启动时把 `PromptRef + 解析结果摘要`记入审计，运行中的会话不因中途改配置而漂移。

#### 审计

新增事件 `agent.prompt.resolved`：

```json
{
  "agentId": "planner",
  "ref": { "kind": "system", "key": "planner" },
  "source": "system",
  "version": 3,
  "scope": "builtin",
  "sessionId": "s_..."
}
```

只在会话开始与每次委派各记一条，不逐轮刷屏；运行详情展示「提示来源：系统 planner / 配置 code-review-v2 / 自定义」。

#### 设置页

- 角色编辑面板「系统提示」改为三段式：
  1. 来源：`系统默认（<key>）` / `配置提示（<key>）` / `自定义`；
  2. 选中后显示只读预览（生效文本）；
  3. 「另存为自定义」把当前文本复制为 inline，允许继续编辑。
- 「系统提示」分区从「10 个固定项」扩展为**提示目录**：builtin 与 custom 同列展示，标注 `内置 / 已覆盖 / 自定义`、版本、被哪些角色引用；支持新建 custom、编辑、恢复默认、删除（被引用时 409 并列出角色）。
- 角色卡增加提示来源徽标：`提示 · 系统 planner` / `提示 · 配置 xxx` / `提示 · 自定义`。

#### 边界

- 提示引用**不携带能力**：工具、技能、权限仍由角色的 `tools / skillIds / defaultCeiling` 决定。
- 引用存在性在保存时校验（未知 key → 400），避免运行期静默回落；删除被引用条目 → 409。
- 不做提示继承链、不做跨角色共享提示变量、不做消息级提示覆盖。

### 3.9 运行期组织：以 AgentSpec 为单元

#### 两类 Agent，必须分开

| | 内联 Agent（internal） | 委派 Agent（delegatable） |
|---|---|---|
| 代表 | `main / intent / planner / replan / iteration-analysis` | `default / coding / planner / executor / reviewer / researcher` + 用户新建 |
| 调用形态 | 单轮 LLM 请求，`tools: []` | `createGoalSession` 生成独立子 Goal |
| 是否进 Goal 树 | 否 | 是，受 `DelegationEdge` 约束 |
| 上下文 | prompt + 当次输入（triage 另带会话历史） | statement + session context + 自己的提示片段 |
| 预算/权限 | 不占任务预算，不改权限 | 继承/收窄 ceiling，分配 budget |
| 输出 | 结构化文本（路由结论 / 计划 JSON） | `summary` + 事件回传父 Goal |
| 可被用户选择 | 否（不出现在会话 Agent 选择器） | 是（P2 起） |

`planner` 与 `coding` 同时出现在两列：同一个 spec 具备两种用法——既作为内联提示槽，又可作为委派角色；只有委派用法吃 `modelId / tools / skillIds / ceiling`。

内联 Agent 是「流水线函数」，不是协作者节点；把 `intent / replan / iteration-analysis` 做成可委派角色会让路由与补计划变成递归任务，成本与不确定性都会不可控。

#### AgentSpec 单一事实源

```ts
interface AgentSpec {
    id: string;
    label: string;
    description?: string;
    promptRef: PromptRef;
    modelId?: string;
    tools?: readonly string[];
    skillIds?: readonly string[];
    defaultCeiling?: PermissionLevel;
    memoryPolicy: 'inherit' | 'isolated';
    // internal=仅内联调用；delegatable=可委派；both=两种用法共用一份定义
    visibility: 'internal' | 'delegatable' | 'both';
    builtin: boolean;
}
```

- `AgentRole` 收敛为 AgentSpec 的持久化投影，`visibility` 固定 `delegatable`；`AgentSpecRegistry` 同时注册内部与委派两类，`planner / coding` 注册为 `both`。
- Runtime 的每个提示注入点改为 `resolveAgentSpec(id)`：`intent / planner / replan / iteration-analysis` 也在注册表里，PromptRef 与委派角色同源，不再有两套 id。
- 委派链路使用 spec 的 `modelId / tools / skillIds / ceiling`，与今天角色字段一致；内部 spec 忽略这些字段（始终单轮、无工具）。
- 兼容：仍接受 `AgentRole` 形状的输入；`visibility` 缺省按 `delegatable`；内置 spec 的可见性由注册表给出（`main / intent / replan / iteration-analysis` = internal，`planner / coding` = both，其余 = delegatable）。

#### 多 Agent 协作的组织

```
root Goal（主执行面，base prompt + session context）
  ├─ SuperAgent 路由提案（rule / model）
  ├─ DelegationEdge → 子 Goal(roleId=coding)     → summary
  ├─ DelegationEdge → 子 Goal(roleId=researcher) → summary
  └─ summary 汇总回 root
内联：intent(triage) / planner / replan / iteration-analysis —— 不产生 Goal
```

- **单向拓扑**：只允许父 → 子委派，子不能反向读取父的完整对话；跨 Agent 共享信息走 blackboard 与 session context，而不是复制 transcript。
- **提示隔离**：每个子 Goal 只拿「基础提示 + 自己的 promptFragment + 自己的技能目录」。一个 Agent 改提示不会污染其他 Agent，也不会改变父的上下文。
- **能力隔离**：spec 的 `tools / skillIds / ceiling` 在创建子会话时冻结，子 Agent 运行期间不可提权；`DelegationEdge` 记录 `roleId / ceiling / budget` 作为审计事实。
- **结果契约**：父只消费子 Goal 的 `summary`、验证状态与事件，不重放子过程；子失败以 `DelegationChildResult.error` 回传，由父决定重试（replan）或放弃。
- **扩展**：并行委派、复核链、辩论都只是「多条 DelegationEdge + 父汇总」，不需要新的提示加载机制；新增编排模式先加 spec 与边，不加新 prompt 通道。

#### 解析生命周期

| 时点 | 行为 |
|---|---|
| Runtime 启动 | 构造 AgentSpecRegistry：builtin spec + 持久化角色合并 |
| 保存提示/角色 | 写 settings.json / SQLite → `restartRuntimes()`，新会话按新配置装配 |
| 会话开始 | 解析一次并记 `agent.prompt.resolved`，会话内提示钉版 |
| 每次委派 | 按 spec 的 PromptRef 重新解析（引用而非快照），配置改动对下一次委派生生效 |

## 4. API 变更

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/roles` | 返回扩展字段 + `builtin/enabled/usageCount` |
| POST | `/api/agent/roles` | 创建（严格校验；含可选 `skillIds`） |
| PUT | `/api/agent/roles/:id` | 更新（局部 patch；含可选 `skillIds`） |
| PATCH | `/api/agent/roles/:id/enabled` | 启停 |
| DELETE | `/api/agent/roles/:id` | 内置角色 409；被引用则提示改用停用 |
| POST | `/api/agent/roles/:id/duplicate` | 复制为新角色 |
| GET/POST | `/api/conversations/:id/agent` | 读写会话级 Agent |
| — | `POST /api/sessions` | 新增可选 `agentId` |
| GET | `/api/agent/prompts` | 提示目录：builtin + custom，含 `scope/version/referencedBy` |
| PUT | `/api/agent/prompts/:key` | upsert：builtin 写覆盖，custom 新建/更新 |
| DELETE | `/api/agent/prompts/:key` | builtin 恢复默认；custom 删除，被引用 409 |
| — | `POST/PUT /api/agent/roles` | 新增可选 `promptRef`；与 `systemPrompt` 互斥归一化 |

## 5. 分期实施（每期最小改动、独立 commit + push）

| 期 | 范围 | 交付 |
|---|---|---|
| **P0** | 设置页自适应 | 断点、`clamp()`、栅格、抽屉；不动数据模型 |
| **P1** | Agent 板块分区 + 角色字段/CRUD | 二级 tab；扩展 `AgentRole`；PUT/PATCH/复制/校验；角色卡片 |
| **P1.5** | PromptRef 统一（3.8 / 3.9） | `prompts` 键放宽；`PromptEntry` + `PromptRef`；内置角色改引用；解析链与 `agent.prompt.resolved`；角色面板提示来源选择 |
| **P1.6** | 提示目录管理 | custom 条目 CRUD、引用计数、删除 409、恢复默认；提示来源徽标 |
| **P2** | Composer Agent chip + 会话钉版 | `agentId` 贯穿 conversation/session/runtime；权限收窄；`agent.selected` 事件 |
| **P3** | `@agent` 消息级覆盖 + 可解释性 | 输入解析、消息标注、运行详情展示路由理由 |

每期顺序：设计补充 → 测试先行 → 实现 → 全量 `pnpm build/test` → commit → push。

### 实施记录

- **P0 完成**（`3b7f8b7`）：内容区 `max-width: 840px`、`padding` 用 `clamp()`；`.setting-item` 窄屏改为上下排布；输入框改为弹性宽度；侧栏导航补充 `focus-visible` 与窄屏压缩。
- **P0 宽屏返工**：去掉 `max-width` 上限，`≥1100px` 时设置卡片用多列布局（`columns: 520px 3`）铺满内容区；Agent 面板在 `≥1080px` 时改为「左侧二级导航 + 右侧内容」双栏，窄屏回退横向 chip。根因是 `style/layout.css` 里还有一条全局 `.settings-page { max-width: 720px }`，组件内必须显式写 `max-width: none` 覆盖。
- **P0 设置页多列范围修正**：宽屏多列只对「由多个独立卡片组成」的分区生效（General / Voice / Storage）；Model、Providers、Auth、Skills、Features、About 这类单面板分区保持整宽。此前所有分区共用一个 `columns` 容器，单卡片页会被挤进 534px 的一列，看起来像内容缩在左边。
- **P0 字号档位**：设置页标题 `clamp(20px, 2.4vw, 26px)`、分组标题/条目名 14px、说明 13px、控件 13px；Agent 面板角色名 14px、描述 12px、徽标/角色 id 11px、表单 label 12px、输入控件 13px、系统提示 12–13px。层级关系不变，只在原来 10–13px 的基础上整体上调一档。
- **P1 UI 部分完成**：Agent 板块拆为「概览 / 角色 / 系统提示 / 模板」四个二级分区；角色卡栅格（`repeat(auto-fill, minmax(240px, 1fr))`）；角色新建/编辑面板，新增**默认模型**选择（留空即跟随会话默认模型）；`AgentRole` 增可选 `description`，新增 `PUT /api/agent/roles/:id`（局部覆盖、未传字段保持原值）。
- **P1 角色技能挂载**：`AgentRole` 增可选 `skillIds`；POST/PUT 接受该字段；委派时子 Goal 获得「角色技能 ∪ 全局挂载」；设置页角色编辑面板新增技能多选，角色卡展示「技能 N」。
- **P2/P3 未开始**：Composer Agent chip、会话级钉版、`@agent` 消息级覆盖（用户明确「Agent 选择配置留后」）。

## 6. 验收标准

- 1280 / 1024 / 768 / 414 四档宽度下设置页无横向滚动、无控件溢出，Agent 四个分区分层清晰。
- 新建角色后立即出现在 Composer 选择器；停用角色不可选但历史会话仍可显示。
- 未选择 Agent 时行为与现状逐字节一致（Auto 路径回归测试）。
- 选择 Agent 后：会话切换/刷新保持；下一条消息生效；权限不足时不可选并有明确提示。
- `@agent` 只影响单条消息，chip 与会话设置不变。
- 事件流可查到 `agent.selected` 的 roleId 与 source。
- 修改 `prompts.planner` 后，`planner` 角色下一次委派即使用新文本；未编辑过的角色无需迁移。
- 自定义角色可选「系统 / 配置 / 自定义」三类提示来源，保存后卡片与运行详情显示来源一致。
- 引用不存在的提示 key 在保存阶段 400；删除被引用条目 409 并列出角色。
- 内联 Agent 仍为单轮、无工具调用；委派链路不因提示改造新增 Goal 层级。

## 7. 风险与边界

- 角色 `systemPrompt` 与 `prompts.<id>` 双来源易混淆 → 统一为 `PromptRef`（3.8）；`systemPrompt` 仅作旧数据兼容，保存时归一化。
- 提示引用指向的 custom 条目被删除 → 保存时校验 + 删除 409，避免运行期静默回落。
- append 语义下，系统提示与主执行面提示可能语气冲突 → 本阶段只允许 append，选择系统条目时在预览里提示「将追加在基础提示之后」。
- 角色过多导致 Auto 路由准确率下降 → 列表按 category 分组，超 8 个给出提示。
- 旧数据兼容：`AgentRole` 新增字段全部可选；缺 `description` 的内置角色补默认文案。
- 权限边界不变：角色只可收窄，不可放大 `permissionCeiling`。
