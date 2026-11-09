# Agent 系统提示（SystemPrompt）配置设计

> 目标：把各 Agent 的系统提示从「代码常量」提升为「可配置模板」，在设置页维护；保存后**新会话生效**，运行中的会话保持创建时的钉版；未配置时回落到代码内置默认。

## 1. 设计约束

- 单一事实源：默认提示只在内置定义中出现一次（`packages/runtime/src/prompts/agent-prompts.ts`），代码路径与设置页都从同一处取默认值，避免两套文案漂移。
- 优先级固定：**配置 > 内置默认**。配置为空字符串/空白视为未配置，回落到默认，便于「恢复默认」。
- 生效时机：读取发生在会话执行装配（`systemPromptWithSkills` / triage / planner / replan / TocAnalyst 每轮调用前），因此保存后**下一次新建会话**使用新提示；已开始执行的 Goal 继续使用当时拼接出的提示（钉版语义，与权限档位一致）。
- 默认值不得因配置缺失而消失：内置默认必须始终可执行，配置只是覆盖。
- 配置只改提示文本，不改工具面、权限、预算与审批，避免提示成为绕过安全约束的入口。

## 2. 配置结构

持久化在 `$MAZI_HOME/settings.json` 的 `prompts` 段：

```json
{
  "prompts": {
    "main": "自定义主 Agent 系统提示",
    "intent": "自定义意图解析提示"
  }
}
```

- 键为 Agent 提示 id（见 §3），值为非空字符串（系统提示全文，支持多行）。
- 空的 `prompts` 段与缺失等价；`""` 视为未配置。
- 写入采用合并：保存单个 Agent 不会覆盖其他 Agent 的配置。
- 运行时投影为 `RuntimeConfig.agentPrompts?: Partial<Record<AgentPromptId, string>>`；`RuntimeConfig.systemPrompt`（宿主直接注入）优先级仍最高，供测试/嵌入式调用使用。

优先级（从高到低）：

| 场景 | 顺序 |
|---|---|
| 主执行面 | `RuntimeConfig.systemPrompt` → `prompts.main` → `prompts.default` → 内置 `GENERAL_PROMPT` |
| 其他 Agent | `prompts.<id>` → 内置默认 |

## 3. Agent 清单与接线点

| id | 名称 | 接线点 | 内置默认 |
|---|---|---|---|
| `main` | 主 Agent | `HarnessRuntime.systemPromptWithSkills` 基础提示 | `GENERAL_PROMPT` |
| `default` | 默认 Agent | `main` 未配置时的兜底基础提示；委派角色 `default` 的提示 | `GENERAL_PROMPT` |
| `coding` | 编码 Agent | SuperAgent 判定 taskKind=coding/debug 时追加的执行规范；委派角色 `coding` 的提示 | `CODING_AGENT_SYSTEM_PROMPT` |
| `planner` | 规划 Agent | Task Planner 轮次的 systemPrompt；委派角色 `planner` | `PLANNER_SYSTEM_PROMPT` |
| `executor` | 执行 Agent | 委派角色 `executor` 的默认提示 | `EXECUTOR_AGENT_SYSTEM_PROMPT` |
| `reviewer` | 审查 Agent | 委派角色 `reviewer` 的默认提示 | `REVIEWER_AGENT_SYSTEM_PROMPT` |
| `researcher` | 研究 Agent | 委派角色 `researcher` 的默认提示 | `RESEARCHER_AGENT_SYSTEM_PROMPT` |
| `intent` | 意图解析 Agent | `HarnessRuntime.parseIntent`（triage） | `GOAL_PARSER_PROMPT` |
| `replan` | Replan Agent | 失败重规划 LLM 轮次的 systemPrompt | `REPLAN_SYSTEM_PROMPT` |
| `iteration-analysis` | 迭代面板分析 Agent | `TocAnalyst.analyze` 的 systemPrompt | `TOC_ANALYZE_PROMPT` |

委派角色（Delegation）解析顺序：已注册/持久化的角色 `systemPrompt`（角色模板显式配置）→ `prompts.<roleId>` → 内置角色默认。角色注册时显式写入的提示始终优先，配置层只提供默认值。

## 4. 生效与重建

- `POST/PUT /api/agent/prompts/:id` 与 `DELETE /api/agent/prompts/:id` 写入 `settings.json`，更新内存 config 并调用 `restartRuntimes()`（不重启进程）。
- 与 `setPermissionCeiling` 同款语义：新会话按新提示装配，已在跑的会话不受影响。
- 启动时 `loadRuntimeConfig` 读取 `prompts` 段，进程重启后配置仍生效。

## 5. API

- `GET /api/agent/prompts` → `{ prompts: AgentPromptView[] }`
- `PUT /api/agent/prompts/:id`，body `{ systemPrompt: string }`；空字符串 = 恢复默认 → `{ prompt }`
- `DELETE /api/agent/prompts/:id` → `{ ok: true }`

`AgentPromptView`：

```ts
interface AgentPromptView {
  id: AgentPromptId;
  label: string;
  description: string;
  defaultPrompt: string;
  override?: string;        // 配置原文（未配置则缺省）
  effectivePrompt: string;  // 实际生效文本
  source: 'config' | 'default';
}
```

未知 id → 400；非字符串 → 400。

## 6. 设置页

在「Agent」设置区新增「SystemPrompt 配置」分节：

- 每个 Agent 一行：名称、id、来源徽标（默认 / 已配置）；
- 展开后可编辑多行文本，保存调用 PUT；「恢复默认」调用 DELETE；
- 底部提示：保存后新会话生效，运行中的会话保持原提示；
- 未配置时文本框展示内置默认（可读不可改，直接编辑即成为覆盖）。

## 7. 测试

1. 默认解析：无配置返回内置默认；空白配置回落默认；配置优先。
2. 主执行面回退链：`main` → `default` → `GENERAL_PROMPT`。
3. 配置持久化：`saveRuntimeSettings({ prompts })` 与既有段合并，`loadRuntimeConfig` 读回 `agentPrompts`；清空后不残留。
4. 运行时生效：`HarnessRuntime` 装配的请求 system 包含自定义 `main` 文本；意图解析轮使用自定义 `intent` 文本。
