# Provider Adapter 设计

1. 决策

| #    | 决策                                                                                                                                                                                                                             | 说明                                                                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PA-1 | 目标包：**`@earendil-works/pi-ai`（0.85.x）**                                                                                                                                                                            | 用户指定的真实目标包（Unified LLM API：provider collections/自动 auth 解析/token 成本统计/多厂商）。注：初稿曾误选同源旧包`@mariozechner/pi-ai`，已纠正并移除依赖；npm 无 scope 的 `pi-ai` 为占位包。                                                   |
| PA-2 | 凭据注入：**优先按 provider 默认 env 读取**（openai→OPENAI_API_KEY、deepseek→DEEPSEEK_API_KEY、anthropic→ANTHROPIC_API_KEY、google→GEMINI_API_KEY、openrouter→OPENROUTER_API_KEY 等）；可用 `driver.apiKeyEnv` 覆盖 | 不把密钥写入配置/仓库。显式配置`apiKeyEnv` 或命中默认映射但缺失 → 首次调用抛出清晰错误；未命中映射的 provider（faux/无鉴权自定义端点）不校验。CLI 提供 `pnpm mazi config` 交互向导，生成的 `providers.json` 通常省略 `apiKeyEnv`（默认映射生效）。 |
| PA-3 | 注册形态：**`DefaultDriverRegistry`** 仅分派 `pi-ai`                                                                                                                                                                   | 缺失或未知`driver.type` 立即失败。                                                                                                                                                                                                                        |
| PA-4 | 驱动配置字段：`{ type: 'pi-ai', api?: string, model: string, apiKeyEnv?: string }`                                                                                                                                             | `api` 默认 `'openai'`（pi-ai 支持的厂商标识，如 openai/anthropic/google/deepseek/openrouter…）；`model` 为厂商模型名。                                                                                                                               |
| PA-5 | baseUrl/自定义端点等 pi-ai 高级配置（OpenAI 兼容网关、代理）本期不重复建模，由 pi-ai 自身的模型注册/env 机制提供                                                                                                                 | 文档标注，后续按需透传。                                                                                                                                                                                                                                    |

---

## 2. 映射规格（core LLMDriver ⇄ pi-ai）

### 2.1 请求方向（我们的契约 → pi-ai）

| 我们的字段                                                    | pi-ai 字段                                                                                            | 处理                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LLMContext.systemPrompt`                                   | `Context.systemPrompt`                                                                              | 直接赋值                                                                                                                            |
| `LLMMessage role='user'`                                    | `UserMessage{role:'user', content, timestamp}`                                                      | 直接                                                                                                                                |
| `LLMMessage role='assistant'`                               | `AssistantMessage`                                                                                  | content →`[{type:'text',text}]`；需补齐 `api/provider/model/usage(零)/stopReason/timestamp`（用当前驱动选中的厂商/模型元信息） |
| `LLMMessage role='assistant' 且携带 toolCallId`（工具意图） | 跳过                                                                                                  | 历史中紧随其后的 tool 结果已含`toolName/toolCallId/content/isError`；工具意图条目内容为空、对真实多轮无增量（详见 2.3 风险）      |
| `LLMMessage role='tool'`                                    | `ToolResultMessage{role:'toolResult', toolCallId, toolName, content:[{type:'text',text}], isError}` | content 以`[error] ` 前缀判定 isError（现有 context-builder 编码）                                                                |
| `LLMContext.tools: ToolSpec[]`                              | `Context.tools: Tool[]`                                                                             | ToolSpec.parameters（JSON-schema 子集对象）按`unknown as TSchema` 透传；pi-ai 转各厂商 function/tool schema                       |
| 模型选择                                                      | `getModel(api, modelId)`                                                                            | 惰性解析并缓存；模型名非法 → pi-ai 抛错透出                                                                                        |

### 2.2 响应方向（pi-ai 事件 → `LLMStreamEvent`）

| pi-ai 事件                                                                        | 产出                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` / `text_start` / `text_end` / `thinking_start` / `thinking_end` | 忽略（文本/推理由 delta 累积）                                                                                                                                                                                                     |
| `text_delta`                                                                    | `{type:'text-delta', delta}`                                                                                                                                                                                                     |
| `thinking_delta`                                                                | `{type:'reasoning-delta', delta}`                                                                                                                                                                                                |
| `toolcall_end`                                                                  | `{type:'tool-call', callId, toolName, arguments}`                                                                                                                                                                                |
| `done`                                                                          | 先`{type:'usage', usage: VendorUsage}`（input/output/cacheRead/cacheWrite/reasoning，reasoning 透传 pi-ai 值，厂商未细分时为 undefined），再 `{type:'end', finishReason}`（stop→stop / length→length / toolUse→tool_calls） |
| `error`                                                                         | 抛`Error`（含 `errorMessage`）——harness 按 driver-error 故障转移/重试                                                                                                                                                        |

`Usage` 映射：`input→inputTokens`、`output→outputTokens`、`cacheRead→cacheReadInputTokens`、`cacheWrite→cacheCreationInputTokens`、`reasoning→reasoningOutputTokens`（`@earendil-works/pi-ai` 的 `Usage.reasoning` 为可选字段、是 `output` 的子集；厂商未提供时为 undefined，直接省略）＋ `reportedByVendor=true`。
`complete(req)`：按 `stream` 消费并聚合文本 + 首个 usage（无工具轮次）。

### 2.3 已知取舍与风险

1. **schema 兼容**：ToolSpec.parameters 为 JSON-schema 子集对象；pi-ai 期望 TypeBox `TSchema`。结构与 JSON Schema 对齐、多数厂商可用；个别关键字（如 `enum`/嵌套 `additionalProperties`）按厂商转译差异需真实凭据联调校准（离线不可验证，同 MVP 风险 E1）。
2. **多轮工具历史**：我们契约的 assistant 工具意图消息无 arguments 字段，adapter 选择跳过并依赖后续 toolResult；若真实厂商严格要求“工具调用与其结果成对出现”，需在 executor context-builder 补充 arguments 透传（独立后续改动）。
3. **reasoning token 细分**：`@earendil-works/pi-ai` 的 `Usage.reasoning`（可选，`output` 子集，Anthropic 等提供）直接透传到 `VendorUsage.reasoningOutputTokens`；厂商未细分时为 undefined（不置 0，避免误记为“有 reasoning”）。
4. **离线可测性**：驱动对网络调用不做 mock（防伪），改为将“请求/响应映射”抽为纯函数并用 pi-ai 事件 fixture 单测；网络路径为 manual（配置真实凭据后验证）。

---

## 3. 实现位置

- `packages/provider/src/pi-ai-mapper.ts`：纯映射函数（toContext/toVendorUsage/translateEvent…）
- `packages/provider/src/pi-ai-driver.ts`：`PiAiDriver implements LLMDriver`（`Models.getModel` 惰性解析、env 校验、`models.stream/complete`）
- `packages/provider/src/pi-ai-mapper.ts`：纯映射（LLMRequest/Context ⇄ pi-ai Context/Tool/Message；事件翻译）
- `packages/provider/src/default-registry.ts`：`DefaultDriverRegistry`（type=pi-ai）
- 测试：pi-ai **faux provider**（`fauxProvider()` + `createModels()`）离线端到端验证 stream/complete 映射，无需真实凭据
- `packages/runtime/src/runtime.ts`：装配点改用 `DefaultDriverRegistry`

## 4. 验收（对应 MVP 文档 §6 扩展）

| #     | 验收项       | 标准                                                                                        |
| ----- | ------------ | ------------------------------------------------------------------------------------------- |
| PA-A1 | 契约不变     | planner/executor/strategy 无源码改动（防腐层）；provider 仍是唯一含外部 LLM 依赖的包（A13） |
| PA-A2 | 映射正确     | 纯函数映射测试覆盖请求/响应/Usage/finishReason（fixture 驱动，离线）                        |
| PA-A3 | 凭据失败语义 | `apiKeyEnv` 配置但缺失 → 首次调用抛含变量名的错误；未配置不阻塞（本地端点）              |
| PA-A4 | 注册分派     | `DefaultDriverRegistry`：type=pi-ai 建 PiAiDriver；缺失或未知 type 抛错                   |
| PA-A5 | 运行时可切换 | runtime 装配使用 DefaultDriverRegistry，真实厂商配置回归                                    |

---

## 5. 模型目录（listModels / modelDetail）

core `LLMProvider` 新增两个只读查询（能力 + 平台价格，USD / 百万 token）：

- `listModels(): ProviderModelInfo[]` —— 当前可用模型；
- `modelDetail(id): ProviderModelInfo | undefined` —— 单模型详情。

pi-ai 适配层从内置目录（含 `model.cost`）映射实现，`client` 包装层透传。**目录外模型**
（厂商新模型 / 自定义，如 `deepseek-v41-flash`）以目录模板克隆元数据后注册，可被
`Models.getModel` 解析并按真实 id 发往厂商；`catalog.ts` 维护本地补充清单并缓存。

API 侧：`ApiRuntimeService.syncProviderModels()` 用该接口把模型（目录 + 保留自定义，合并）
与平台价格写回 `providers.json`；`POST /api/config/sync` 手动触发，设置→模型有「同步模型」按钮。
