# Provider Adapter 设计（pi-ai 真实厂商接入）

> **版本**：v0.1
> **依据**：总体设计 v1.2 §3.4/§9（provider-llm 为唯一外部 LLM 依赖、适配 pi-ai）；MVP 文档 v1.0 ADR D3（真实厂商接入为延后 Feature，接口不变）与附录 A E1。
> **范围**：MVP 的 ScriptedDriver 保持不变；新增真实厂商 Driver（pi-ai），经现有 `LLMDriver` 防腐层注入，上层（planner/executor/strategy/runtime）零改动。

---

## 1. 决策

| # | 决策 | 说明 |
| - | ---- | ---- |
| PA-1 | 目标包：**`@mariozechner/pi-ai`（0.73.x）** | 唯一活跃的“pi-ai”实现（Unified LLM API：自动模型发现/多厂商/工具调用/成本统计）；npm 无 scope 的 `pi-ai` 为占位包（0.0.1，无代码），`@pioneer-platform/pi-ai` 等为个人分叉。 |
| PA-2 | 凭据注入：**`driver.apiKeyEnv`（读环境变量）**；pi-ai 自身按厂商读标准 env | 不把密钥写入配置/仓库。`apiKeyEnv` 显式配置但缺失 → 首次调用抛出清晰错误；未显式配置时按厂商默认 env 名（OPENAI_API_KEY/ANTHROPIC_API_KEY/…）读取，缺失不阻塞（兼容本地无鉴权端点）。 |
| PA-3 | 注册形态：**`DefaultDriverRegistry`** 按 `driver.type` 分派（`scripted` 保持默认演示；`pi-ai` 走真实厂商） | harness-runtime 装配点改用它；原 `ScriptedDriverRegistry` 保留导出兼容。 |
| PA-4 | 驱动配置字段：`{ type: 'pi-ai', api?: string, model: string, apiKeyEnv?: string }` | `api` 默认 `'openai'`（pi-ai 支持的厂商标识，如 openai/anthropic/google/deepseek/openrouter…）；`model` 为厂商模型名。 |
| PA-5 | baseUrl/自定义端点等 pi-ai 高级配置（OpenAI 兼容网关、代理）本期不重复建模，由 pi-ai 自身的模型注册/env 机制提供 | 文档标注，后续按需透传。 |

---

## 2. 映射规格（core LLMDriver ⇄ pi-ai）

### 2.1 请求方向（我们的契约 → pi-ai）

| 我们的字段 | pi-ai 字段 | 处理 |
| ---------- | ---------- | ---- |
| `LLMContext.systemPrompt` | `Context.systemPrompt` | 直接赋值 |
| `LLMMessage role='user'` | `UserMessage{role:'user', content, timestamp}` | 直接 |
| `LLMMessage role='assistant'` | `AssistantMessage` | content → `[{type:'text',text}]`；需补齐 `api/provider/model/usage(零)/stopReason/timestamp`（用当前驱动选中的厂商/模型元信息） |
| `LLMMessage role='assistant' 且携带 toolCallId`（工具意图） | 跳过 | 历史中紧随其后的 tool 结果已含 `toolName/toolCallId/content/isError`；工具意图条目内容为空、对真实多轮无增量（详见 2.3 风险） |
| `LLMMessage role='tool'` | `ToolResultMessage{role:'toolResult', toolCallId, toolName, content:[{type:'text',text}], isError}` | content 以 `[error] ` 前缀判定 isError（现有 context-builder 编码） |
| `LLMContext.tools: ToolSpec[]` | `Context.tools: Tool[]` | ToolSpec.parameters（JSON-schema 子集对象）按 `unknown as TSchema` 透传；pi-ai 转各厂商 function/tool schema |
| 模型选择 | `getModel(api, modelId)` | 惰性解析并缓存；模型名非法 → pi-ai 抛错透出 |

### 2.2 响应方向（pi-ai 事件 → `LLMStreamEvent`）

| pi-ai 事件 | 产出 |
| ---------- | ---- |
| `start` / `text_start` / `text_end` / `thinking_start` / `thinking_end` | 忽略（文本/推理由 delta 累积） |
| `text_delta` | `{type:'text-delta', delta}` |
| `thinking_delta` | `{type:'reasoning-delta', delta}` |
| `toolcall_end` | `{type:'tool-call', callId, toolName, arguments}` |
| `done` | 先 `{type:'usage', usage: VendorUsage}`（input/output/cacheRead/cacheWrite/reasoning(无则0)），再 `{type:'end', finishReason}`（stop→stop / length→length / toolUse→tool_calls） |
| `error` | 抛 `Error`（含 `errorMessage`）——harness 按 driver-error 故障转移/重试 |

`Usage` 映射：`input→inputTokens`、`output→outputTokens`、`cacheRead→cacheReadInputTokens`、`cacheWrite→cacheCreationInputTokens`、`reasoning=0`（pi-ai 未细分）＋ `reportedByVendor=true`。
`complete(req)`：按 `stream` 消费并聚合文本 + 首个 usage（无工具轮次）。

### 2.3 已知取舍与风险

1. **schema 兼容**：ToolSpec.parameters 为 JSON-schema 子集对象；pi-ai 期望 TypeBox `TSchema`。结构与 JSON Schema 对齐、多数厂商可用；个别关键字（如 `enum`/嵌套 `additionalProperties`）按厂商转译差异需真实凭据联调校准（离线不可验证，同 MVP 风险 E1）。
2. **多轮工具历史**：我们契约的 assistant 工具意图消息无 arguments 字段，adapter 选择跳过并依赖后续 toolResult；若真实厂商严格要求“工具调用与其结果成对出现”，需在 executor context-builder 补充 arguments 透传（独立后续改动）。
3. **reasoning token 细分**：pi-ai Usage 无 reasoning 分项，VendorUsage.reasoning 置 0（标注不精确）。
4. **离线可测性**：驱动对网络调用不做 mock（防伪），改为将“请求/响应映射”抽为纯函数并用 pi-ai 事件 fixture 单测；网络路径为 manual（配置真实凭据后验证）。

---

## 3. 实现位置

- `packages/provider-llm/src/pi-ai-mapper.ts`：纯映射函数（toContext/toVendorUsage/translateEvent…）
- `packages/provider-llm/src/pi-ai-driver.ts`：`PiAiDriver implements LLMDriver`（惰性 getModel、env 校验、stream/complete）
- `packages/provider-llm/src/registry.ts`：新增 `DefaultDriverRegistry`（type=scripted|pi-ai）
- `packages/harness-runtime/src/runtime.ts`：装配点改用 `DefaultDriverRegistry`

## 4. 验收（对应 MVP 文档 §6 扩展）

| # | 验收项 | 标准 |
| - | ------ | ---- |
| PA-A1 | 契约不变 | planner/executor/strategy 无源码改动（防腐层）；provider-llm 仍是唯一含外部 LLM 依赖的包（A13） |
| PA-A2 | 映射正确 | 纯函数映射测试覆盖请求/响应/Usage/finishReason（fixture 驱动，离线） |
| PA-A3 | 凭据失败语义 | `apiKeyEnv` 配置但缺失 → 首次调用抛含变量名的错误；未配置不阻塞（本地端点） |
| PA-A4 | 注册分派 | `DefaultDriverRegistry`：type=scripted 建 ScriptedDriver；type=pi-ai 建 PiAiDriver；未知 type 抛错 |
| PA-A5 | 运行时可切换 | harness-runtime 装配改用 DefaultDriverRegistry，scripted 演示用例回归全绿 |
