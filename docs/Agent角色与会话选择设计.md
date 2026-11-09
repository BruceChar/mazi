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

角色内 `systemPrompt` 显式设置时优先于 `prompts.<roleId>`；两者都缺省时用主执行面基础提示，保证任何角色都能跑。

### 3.4 审计与可解释性

- 新增事件 `agent.selected`：`{ roleId, source: 'picker' | 'mention' | 'auto', reason, ceiling, tools }`，落在 Goal 事件流。
- 运行详情面板展示「本次由谁执行、为什么」；Auto 路由展示 `description` 命中理由（沿用 SuperAgent trace）。
- 会话列表可按 Agent 过滤（后续）。

### 3.5 设置页自适应规则

| 断点 | 布局 |
|---|---|
| ≥1024px | 侧栏 220px + 内容 `max-width: 840px`，角色卡栅格 2–3 列（`repeat(auto-fill, minmax(280px, 1fr))`） |
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

## 4. API 变更

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agent/roles` | 返回扩展字段 + `builtin/enabled/usageCount` |
| POST | `/api/agent/roles` | 创建（严格校验） |
| PUT | `/api/agent/roles/:id` | 更新（局部 patch） |
| PATCH | `/api/agent/roles/:id/enabled` | 启停 |
| DELETE | `/api/agent/roles/:id` | 内置角色 409；被引用则提示改用停用 |
| POST | `/api/agent/roles/:id/duplicate` | 复制为新角色 |
| GET/POST | `/api/conversations/:id/agent` | 读写会话级 Agent |
| — | `POST /api/sessions` | 新增可选 `agentId` |

## 5. 分期实施（每期最小改动、独立 commit + push）

| 期 | 范围 | 交付 |
|---|---|---|
| **P0** | 设置页自适应 | 断点、`clamp()`、栅格、抽屉；不动数据模型 |
| **P1** | Agent 板块分区 + 角色字段/CRUD | 二级 tab；扩展 `AgentRole`；PUT/PATCH/复制/校验；角色卡片 |
| **P2** | Composer Agent chip + 会话钉版 | `agentId` 贯穿 conversation/session/runtime；权限收窄；`agent.selected` 事件 |
| **P3** | `@agent` 消息级覆盖 + 可解释性 | 输入解析、消息标注、运行详情展示路由理由 |

每期顺序：设计补充 → 测试先行 → 实现 → 全量 `pnpm build/test` → commit → push。

### 实施记录

- **P0 完成**（`3b7f8b7`）：内容区 `max-width: 840px`、`padding` 用 `clamp()`；`.setting-item` 窄屏改为上下排布；输入框改为弹性宽度；侧栏导航补充 `focus-visible` 与窄屏压缩。
- **P1 UI 部分完成**：Agent 板块拆为「概览 / 角色 / 系统提示 / 模板」四个二级分区；角色卡栅格（`repeat(auto-fill, minmax(240px, 1fr))`）；角色新建/编辑面板，新增**默认模型**选择（留空即跟随会话默认模型）；`AgentRole` 增可选 `description`，新增 `PUT /api/agent/roles/:id`（局部覆盖、未传字段保持原值）。
- **P2/P3 未开始**：Composer Agent chip、会话级钉版、`@agent` 消息级覆盖（用户明确「Agent 选择配置留后」）。

## 6. 验收标准

- 1280 / 1024 / 768 / 414 四档宽度下设置页无横向滚动、无控件溢出，Agent 四个分区分层清晰。
- 新建角色后立即出现在 Composer 选择器；停用角色不可选但历史会话仍可显示。
- 未选择 Agent 时行为与现状逐字节一致（Auto 路径回归测试）。
- 选择 Agent 后：会话切换/刷新保持；下一条消息生效；权限不足时不可选并有明确提示。
- `@agent` 只影响单条消息，chip 与会话设置不变。
- 事件流可查到 `agent.selected` 的 roleId 与 source。

## 7. 风险与边界

- 角色 `systemPrompt` 与 `prompts.<id>` 双来源易混淆 → 统一：角色只存 `promptId + 可选覆盖`，UI 明确标注来源。
- 角色过多导致 Auto 路由准确率下降 → 列表按 category 分组，超 8 个给出提示。
- 旧数据兼容：`AgentRole` 新增字段全部可选；缺 `description` 的内置角色补默认文案。
- 权限边界不变：角色只可收窄，不可放大 `permissionCeiling`。
