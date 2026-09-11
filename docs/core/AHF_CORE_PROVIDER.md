# Provider Core 契约设计(core-provider.md)

|                    |                                                                       |
| ------------------ | --------------------------------------------------------------------- |
| **文档 ID**  | PROVIDER-CORE                                                         |
| **版本**     | v1.0                                                                  |
| **状态**     | 定稿(实现依据)                                                        |
| **适用范围** | `provider-core` 契约层及所有 Provider Adapter 实现                  |
| **关联文档** | PROVIDER-RUNTIME(计价、画像、健康度、重试/failover、装配，均在彼文档) |
| **代码实现** | `provider-core/src/provider.ts`(本文档不携带实现代码)               |

---

## 1. 概述

### 1.1 目标

定义一套与厂商无关的 LLM 通信核心语义契约，作为整个系统的**防腐层边界**：

1. **协议转换**：语义层(本契约)与 wire 层(各厂商 API)解耦，厂商差异收敛在 Adapter 内；
2. **双入口执行**:`ask`(非流式，对应厂商 chat complete 端点)与 `askStream`(流式)两个入口，共享同一套校验、归一化与错误语义；
3. **不变量契约化**：消息结构、事件序列、错误分类、token 语义均以可测试的规范形式固定，调用方无需了解厂商细节即可安全编程。

### 1.2 范围与非目标

**范围内**：内容块体系、消息模型、工具协议、请求/流式事件/响应契约、能力声明、错误分类、厂商适配规范。
**非目标**(全部移交 PROVIDER-RUNTIME):

| 事项                                                  | 归属                                       |
| ----------------------------------------------------- | ------------------------------------------ |
| 流式事件的消费侧聚合**实现**                    | RUNTIME §3(语义规范仍由本文档 §7.3 定义) |
| 重试/退避/failover 决策(含“某错误是否可重试”的判断) | RUNTIME §6                                |
| 计价、分时档位、成本核算                              | RUNTIME §5                                |
| 性能/经济画像、健康分                                 | RUNTIME §7 / §8                          |
| RPM/TPM/并发限流、超时编排                            | RUNTIME §4 / §6                          |
| Provider 注册、配置装配、启动校验                     | RUNTIME §9                                |
| 响应时序测量(TTFT 等)                                 | RUNTIME §4                                |
| 会话持久化、消息 ID 分配                              | 会话域                                     |
| 块级 cache_control、多模态输出、批量 API              | 后续版本(§17)                             |

### 1.3 核心设计原则

1. **事实，不做判断**：core 只承载两类内容——厂商 wire 层披露的事实(usage、错误码、 finishReason),以及不做转译就会产生错误结果的规范(成对校验、system 归一)。任何表达“接下来该怎么办”或“我们量出来的东西”的字段，一律不属于 core。
2. **Block / Delta 二分**：Block 是消息中的完整内容单元(协议不变量)，Delta 是流式增量(传输态)。二者永不混用。
3. **语义归一在 core,wire 巣异在 Adapter**:system 提示的位置、工具历史的形状、token 计数口径等，由 core 定义唯一规范语义，Adapter 负责映射。
4. **双入口等价(EQUIV)**:`ask` 与 `askStream` 是同一语义的两个投影——共享请求校验、能力协商、错误映射与归一化逻辑；差异只允许存在于网络收发与事件切分层。等价性由 RUNTIME 的聚合器与 fixture 测试共同守护(§9.2)。
5. **能力协商快速失败**：请求携带模型不支持的特性 → 请求期立即报错，禁止静默忽略(静默降级 = 行为漂移)。
6. **一等字段 = wire 语义，行李 = metadata**:契约类型上的每个一等字段必须在厂商请求/响应中承载协议语义；调用方想随消息携带的会话域/观测域数据(会话 ID、耗时、trace 等)一律走显式 opaque 的 `metadata`,core 不赋予其类型可见性，Adapter 禁止读取依赖。
7. **不变量进类型与测试**：契约约束以类型形状 + 校验函数 + fixture 测试三重固定，不依赖实现者自觉。

---

## 2. 概念模型总览

```
                 LLMRequest
┌────────────┐
│            │   ask()        →  Promise<LLMResponse>(Block 级完整响应)
│  调用方     │
│ (Runtime)  │   askStream()  →  AsyncIterable<StreamCompletionEvent>(Delta 级事件流)
└────────────┘
                     │
              ┌──────┴──────┐
              │ LLMProvider │ ← 厂商 Adapter 实现(OpenAI / Anthropic / Gemini / …)
              └─────────────┘
                     │ 协议转换 + 网络收发
                     ▼
              厂商 wire 层 API
```

| 对象                                           | 职责                                               |
| ---------------------------------------------- | -------------------------------------------------- |
| `ContentBlock`                               | 消息内容的完整单元                                 |
| `LLMMessage`                                 | 对话消息，多轮历史的唯一表达                       |
| `ToolSchema` / `ToolCall` / `ToolResult` | 工具协议三元组：声明 / 意图 / 结果                 |
| `LLMRequest`                                 | 一次调用的完整语义(含 system 提示)                 |
| `StreamCompletionEvent`                      | `askStream` 产出的流式增量与生命周期事件         |
| `LLMResponse`                                | `ask` 的直接返回(Block 级完整响应，含 toolCalls) |
| `ProviderCapabilities`                       | 模型能力声明(厂商静态事实)，请求期协商依据         |
| `ProviderError`                              | 结构化错误分类；策略判断在 RUNTIME                 |

---

## 3. 内容类型与内容块

### 3.1 内容类型

内容块分为八种：

| 类型            | 用途               | 合法出现位置           | 原生支持(示例)            | 不支持时的处置                |
| --------------- | ------------------ | ---------------------- | ------------------------- | ----------------------------- |
| `text`        | 文本               | 全部消息               | 全部                      | —                            |
| `image`       | 图像               | user / tool 结果       | OpenAI、Anthropic、Gemini | —                            |
| `audio`       | 音频               | user                   | OpenAI、Gemini            | 降级(见下)                    |
| `video`       | 视频               | user                   | Gemini                    | 降级(见下)                    |
| `document`    | PDF、DOCX、TXT、MD | user                   | Anthropic(PDF)            | 调用方预处理为 text           |
| `spreadsheet` | CSV、XLSX          | user                   | 无原生                    | 转 text(name 进 metadata)     |
| `code`        | 代码文件           | user                   | 无原生                    | 转 text(language 进 metadata) |
| `reasoning`   | 推理/思考过程      | **仅 assistant** | Anthropic(带 signature)   | 不回传(§5.4)                 |

### 3.2 数据表达规范

所有携带 `data` 的块(image/audio/video/document/spreadsheet/code)遵循同一规范：

1. `data` 只允许两种形态：**URL** 或 **data URI**(`data:<mime>;base64,<payload>`);
2. 裸 base64 是契约违规，校验函数直接拒绝；
3. Adapter 映射规则：需要 base64 + media type 的厂商(Anthropic)从 data URI 解析；接受 URL 的厂商(OpenAI)直传，data URI 也直传；`mimeType` 字段与 data 实际值冲突时以 data 为准并记录诊断。

### 3.3 降级规则(防静默丢失)

Adapter 遇到厂商不支持的输入块类型时，不得静默丢弃。两种合法处理：

- (a) 请求期能力协商拦截(推荐，§10.2):块类型 ∉ `inputTypes` 且无降级路径 → `invalid_request`;
- (b) 转换为等价 text 块并在诊断日志记录降级事实(适用于 spreadsheet / code / document 等可文本化类型)。
  厂商即不支持原生传输、又无法等价文本化的块(如 audio → 纯文本模型)→ 请求期 `invalid_request`。

### 3.4 ReasoningBlock 的定位

1. Reasoning 是 assistant 输出的组成部分，与 text 平级，不是独立通道；
2. 流式阶段通过 `reasoning_delta` 事件到达；非流式阶段直接出现在 `LLMResponse.content`;
3. 重建多轮历史时是否回传给厂商，是 Adapter 的厂商适配职责(§5.4、§13);
4. 契约不承诺 ReasoningBlock 一定存在——未开启 thinking 或厂商不输出 reasoning 时，content 中无该块。

---

## 4. 消息模型

### 4.1 消息类型

消息分四种 role,共同基类携带会话域行李：

| 消息类型      | content 形状                   | 说明                                         |
| ------------- | ------------------------------ | -------------------------------------------- |
| `system`    | TextBlock[]                    | 系统提示(仅前缀区合法，§4.2)                |
| `user`      | ContentBlock[]                 | 用户输入，多模态                             |
| `assistant` | ContentBlock[] +`toolCalls?` | 模型输出；工具意图为一等字段，不混入 content |
| `tool`      | `results: ToolResult[]`      | 一条消息可承载多个并行工具调用的结果         |

### 4.2 System 提示：双入口 + 前缀区规则

厂商对 system prompt 的 API 形态存在本质差异：

| 厂商                                | system 的 wire 形态                  |
| ----------------------------------- | ------------------------------------ |
| OpenAI / DeepSeek / OpenAI 兼容网关 | messages 数组首条 system 消息        |
| Anthropic                           | 顶层`system` 参数(支持 block 数组) |
| Gemini                              | 顶层`systemInstruction` 字段       |

**因此契约不能预设单一 wire 形态，采用“语义层双入口、wire 层由 Adapter 决定”策略**：

- **顶层 `LLMRequest.system`**(简写形态):单字符串或多段文本块。简单场景一行配置；
- **`SystemMessage`(messages 内，保真形态)**：多段系统提示保真、外部会话重放、分段指令拼接(如“基础人设 + 本次任务约束”)；
- 两入口同时使用时，**顶层在前、消息内在后**，顺序确定无歧义。
  **归一化算法(SYSTEM-NORM)**:

1. 依序收集：顶层 `request.system`(string 展开为单 TextBlock)→ messages **前缀区**中每条 SystemMessage 的 content;
2. **前缀区定义**:messages 中所有 SystemMessage 必须出现在第一条非 system 消息之前，前缀区之后出现 SystemMessage → 契约违规，校验层拒绝(§12);
3. 产出：有序 TextBlock 序列(空序列 = 无系统提示)。
   **Adapter 映射规则**：
4. | 目标厂商形态                | 映射                                                                                          |
   | --------------------------- | --------------------------------------------------------------------------------------------- |
   | 顶层单字符串                | 块序列以`"\n\n"` 连接(连接行为是规范行为，写入测试)                                         |
   | 顶层 block 数组(Anthropic)  | 原样映射为 text blocks(为未来块级 cache 标记保留结构)                                         |
   | 首条 system 消息(OpenAI 系) | 合并为一条首消息；即使多条 SystemMessage 也合并为一条，不依赖厂商对多条 system 消息的处理差异 |

**为什么禁止中缀 system**:对话中间的 system 消息在厂商间语义分裂(有的按 user 处理、有的拒收、有的忽略)，允许它等于在契约里埋一个静默行为漂移点。中途纠正指令应由调用方以 user 消息表达。

### 4.3 多轮工具历史(成对不变量 TOOL-PAIR)

工具意图与结果必须成对，这是重建历史时厂商 400 的第一大来源：
**不变量(TOOL-PAIR)**:

1. `AssistantMessage.toolCalls` 中的每个 `callId`,必须在其后(允许隔若干消息)的某条 ToolMessage 的 `results` 中出现；
2. 每个 `ToolResult.callId` 必须能匹配此前某条 AssistantMessage 的 toolCalls;
3. 匹配范围按**全对话顺序**判定，不要求紧邻；
4. 成对性校验在两层执行：Runtime 请求构造层(主责)+ Provider 请求校验(兜底，违规按 `invalid_request` 拒绝——真实厂商必然 400,提前失败语义一致)。
   **ToolMessage 的形状自由度**：一条 ToolMessage 可承载多个 results(对应一轮并行工具调用)。Adapter 负责向两种厂商形态映射：OpenAI 系“每个 tool_call 一条 tool 消息”(展开)；Anthropic“一条 user 消息内多个 tool_result block”(合并)。

### 4.4 消息级校验规则汇总

| 规则                                    | 级别 | 处置                 |
| --------------------------------------- | ---- | -------------------- |
| SystemMessage 位于前缀区                | 契约 | 校验拒绝             |
| reasoning 块出现在 user / system / tool | 契约 | 校验拒绝             |
| TOOL-PAIR 成对性                        | 契约 | 校验拒绝(两层)       |
| 空消息(content 与 toolCalls 均空)       | 契约 | 校验拒绝             |
| 行李字段                                | 约定 | Adapter 禁止读取依赖 |

---

## 5. 工具协议

### 5.1 三元组

| 对象           | 字段要点                                           | 说明                                                 |
| -------------- | -------------------------------------------------- | ---------------------------------------------------- |
| `ToolSchema` | name / description / parameters(object schema)     | 声明                                                 |
| `ToolCall`   | callId / name / arguments(对象)                    | 意图；arguments 在`ask` 返回时已解析               |
| `ToolResult` | callId / output(string\| ContentBlock[]) / isError | 结果；isError 为一等字段，禁止以`[error]` 前缀编码 |

### 5.2 规则

1. **callId 统一命名**：意图与结果同名对齐(区别于消息级 `id`);
2. **isError 映射**：Anthropic `is_error` 原生；OpenAI 系无原生标记 → wire 层降级编码为 `[tool error] ...` 前缀(仅 wire 层，契约层无前缀语义)；
3. **output 类型收窄**：只接受 `string | ContentBlock[]`。工具产出原始对象时由调用方序列化为 JSON 字符串(序列化是调用方职责，契约不猜)；
4. **parameters 结构校验**(请求期)：
   - 存在时顶层必须为 object schema(`type:'object'` 或含 `properties`);
   - `required` 的键 ⊆ `properties` 键集；
   - 约束-类型匹配:`minLength/maxLength/pattern` 仅 string,`minimum/maximum` 仅 number,`items` 仅 array;
   - 其余 JSON Schema 关键字透传，行为由厂商兜底(风险登记 §17)。

### 5.3 ToolChoice 适配

| ToolChoice   | OpenAI 系                        | Anthropic           | Gemini                       |
| ------------ | -------------------------------- | ------------------- | ---------------------------- |
| `auto`     | tool_choice:'auto'               | 不设 tool_choice    | mode: AUTO                   |
| `none`     | tool_choice:'none'(或不传 tools) | 不传 tools          | 不传 tools                   |
| `required` | tool_choice:'required'           | {type:'any'}        | mode: ANY                    |
| `{name}`   | {type:'function',…}             | {type:'tool', name} | mode: ANY + allowed function |

**禁止静默降级**：厂商无法表达 `required` / `{name}` 时 → `invalid_request` 快速失败，不得降级为 `auto`。

### 5.4 ReasoningBlock 回传矩阵

| 厂商           | 回传规则                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic      | 开启 extended thinking 的轮次：带 signature 的 reasoning 块**必须**回传(thinking block 在 tool_use block 之前)；缺失 → 厂商 400 |
| DeepSeek R1 系 | 工具调用轮次建议回传 reasoning(按厂商当前文档)；纯文本轮次不回传                                                                       |
| OpenAI o 系    | 一律不回传                                                                                                                             |

---

## 6. 请求契约

### 6.1 请求字段一览

| 字段                                  | 类型 / 形态                     | 缺省语义              | 违约处置                                                    |
| ------------------------------------- | ------------------------------- | --------------------- | ----------------------------------------------------------- |
| `model`                             | 模型标识                        | provider.defaultModel | 均缺或 id 不存在 → invalid_request                         |
| `system`                            | string\| TextBlock[]            | 无系统提示            | 非前缀区 system → 校验拒绝                                 |
| `messages`                          | LLMMessage[]                    | 必填                  | 空数组 / 违反 §4.4 → 校验拒绝                             |
| `tools`                             | ToolSchema[]                    | 无工具(纯对话)        | 不支持而携带 → invalid_request                             |
| `toolChoice`                        | auto / none / required / {name} | auto(当有 tools)      | 厂商无法表达 → invalid_request                             |
| `temperature` / `topP` / `stop` | number / string[]               | 厉商缺省(不设值)      | 透传                                                        |
| `maxTokens`                         | number                          | 厂商缺省              | > maxOutputTokens → invalid_request                        |
| `responseFormat`                    | json_object / json_schema       | 无                    | 不支持 → invalid_request;json_schema 缺 schema → 校验拒绝 |
| `thinking`                          | {budgetTokens?}                 | 不开启                | 不支持 → invalid_request                                   |
| `signal`                            | AbortSignal                     | 不取消                | abort → 抛 aborted 错误(不携带策略语义)                    |
| `extra`                             | Record<string, unknown>         | 空                    | 透传守则见 §6.3                                            |

**不设 `stream` 字段**：流式与否由调用方法(`ask` / `askStream`)决定，请求对象内再放一个布尔即构成双真相源。   **超时不在 core**:core 只透传 `signal` 并在触发时报告 `aborted`。超时是 runtime 的编排判断(定时器由 RUNTIME §4 合成信号)。

### 6.2 extra 透传守则

1. core 不承诺其中任何字段的语义；不同 Adapter 对同一 key 的解释可以不同；
2. 路由/策略层禁止依赖 extra 中的字段做决策(依赖即破坏防腐层)；
3. 生产配置审查时 extra 非空视为需要显式 review 的项；
4. Adapter 应在文档中列出自己识别的 extra key 白名单，未识别 key 透传或丢弃(逐 Adapter 声明，不统一规定)。

---

## 7. 流式事件契约(`askStream`)

### 7.1 事件类型

| 事件                 | 载荷要点                        | 说明                             |
| -------------------- | ------------------------------- | -------------------------------- |
| `start`            | responseId? / model?            | 恰好一次，必为首事件             |
| `text_delta`       | text                            | 文本增量                         |
| `reasoning_delta`  | reasoning                       | 推理增量                         |
| `tool_call_start`  | index / callId / name           | 并行工具调用的槽位               |
| `tool_call_delta`  | index / argumentsDelta          | arguments 的 JSON 文本片段       |
| `tool_call_stop`   | index                           | 封槽                             |
| `usage`            | TokenUsage                      | 成功流中恰好一次，在 finish 之前 |
| `finish`           | finishReason + rawFinishReason? | 恰好一次，末事件                 |
| **注意两点**： |                                 |                                  |

1. **错误不是事件**：流中的失败以异常(`ProviderError`)终止迭代——`for await` 的自然错误通道，避免“部分事件已消费后出现 error 事件、消费方状态如何处置”的歧义；
2. **事件不携带时间戳**：到达时刻是调用侧的测量事实，归 RUNTIME §4 打点。core 事件只承载厂商披露的内容。

### 7.2 事件序列不变量(可测)

1. `start` 恰好一次，且必为首事件；
2. `text_delta` / `reasoning_delta` 可任意交错、任意次数；
3. 同一 `index` 的 tool call 事件满足 `start → delta* → stop` 顺序；不同 index 之间可交错(厂商并行流式工具调用的真实形态)；
4. `usage` 在成功流中**恰好一次**，且在 `finish` 之前；异常终止的流可缺失；
5. `finish` 恰好一次，且为末事件；此后迭代器结束；
6. `start` 之前的异常(握手失败等)合法——此时零事件，仅异常。

### 7.3 消费侧聚合语义(规范在此，实现在 RUNTIME §3)

core 不提供聚合函数，但消费侧的聚合行为是本契约规范的一部分，两入口等价性(§9.2)以此为对照基准：

1. text_delta 按到达顺序拼接 → 单个 TextBlock;reasoning_delta 拼接 → 单个 ReasoningBlock;二者按**到达顺序**排列(厂商先出 reasoning 后出文本则顺序如实反映)；
2. tool call 按 `index` 分组：start 建立槽位；delta 按到达顺序做**字符串拼接**；stop 封槽；封槽后对拼接结果 `JSON.parse` → ToolCall;
3. 空 content 且无 toolCalls → 以 TextBlock("")占位(下游无需判空)；
4. usage / finishReason / id 从对应事件提取；
5. 畸形 tool call(截断 / parse 失败)的处置遵循 §9.3;
6. `start` 前收到异常 → 该轮次无任何结果，异常按 §11 分类上抛。

---

## 8. Token Usage 语义

### 8.1 Usage 模型(对齐 OpenAI 范式)

Usage 语义以 OpenAI 计数范式为规范基线：**inputTokens 与 outputTokens 是总量的第一字段，缓存与推理为正交细分维度**。

| 字段                           | 语义                                     |
| ------------------------------ | ---------------------------------------- |
| `inputTokens`                | **全部输入 token(含缓存命中部分)** |
| `outputTokens`               | **全部输出 token(含推理 token)**   |
| `cachedInputTokens`          | inputTokens 的子集：缓存命中的输入部分   |
| `cachedWriteInputTokens`     | inputTokens 的子集：缓存写入(创建)的输入部分(Anthropic 型厂商) |
| `reasoningTokens`            | outputTokens 的子集：模型推理/思考部分   |
| **子集语义用图示表达**： |                                          |

```
inputTokens  ┌────────────────────── 全部输入 ──────────────────────┐
             │  新输入                       │  cachedInputTokens    │
             └────────────────────────────────┴───────────────────────┘
outputTokens ┌────────────────────── 全部输出 ──────────────────────┐
             │  正文输出                     │  reasoningTokens      │
             └────────────────────────────────┴───────────────────────┘
```

**字段未定义 = 厂商未报告**，语义上不等于 0;计费层(RUNTIME §5)按 0 处理，统计层应区分“未报告”与“零”。

### 8.2 各厂商归一规则

| 厂商      | wire 语义                                                            | Adapter 归一动作                                                                                                               |
| --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI    | prompt_tokens 含 cached_tokens;completion_tokens 含 reasoning_tokens | 直填:inputTokens = prompt_tokens,outputTokens = completion_tokens;cachedInputTokens / reasoningTokens 独立填充                 |
| Anthropic | input_tokens 不含 cache_read/creation;output 含 thinking             | **相加后填充**:inputTokens = input_tokens + cache_read + cache_creation;cachedInputTokens = cache_read;outputTokens 直填 |
| Gemini    | promptTokenCount 与 cachedContent 计数                               | 按 OpenAI 同型(含 → 直填)，以 SDK 实测校准                                                                                    |
| DeepSeek  | prompt_tokens 含 prompt_cache_hit_tokens                             | 经 pi-ai openai-completions 时其 `input` 已是 miss 部分 → **相加后填充**：inputTokens = input + cache_read + cache_write；cachedInputTokens = cache_read；cachedWriteInputTokens = cache_write |
| pi-ai 桥接（全部 openai-completions 型） | `input` 为未命中缓存部分，`totalTokens = input + output + cacheRead + cacheWrite` | **相加后填充**（见 `normalizePiUsage`）：inputTokens = input + cacheRead + cacheWrite；缓存读/写作为子集保留；outputTokens 直填（已含 reasoning） |

**设计理由**：派生补全(如 `prompt − cached`)跨厂商行为漂移大，不做派生；**补全动作本身**是归一化的一部分(Anthropic 需相加)，保证“单次调用各自函数语义一致”。core 保证供给计费层的是无歧义总量事实。

### 8.3 辅助函数

core 提供只读辅助 `computeTotalTokens(usage)`,按 §8.1 语义求和——**契约上不设 totalTokens 字段**，派生值进契约即双真相源。

## 8.8. 错误体系

### 8.8.1 错误码集合

| code                        | 语义                                          | 厂商来源(示例)                                |
| --------------------------- | --------------------------------------------- | --------------------------------------------- |
| `rate_limit`              | 厂商限流                                      | HTTP 429,含 retry-after 头时解析 retryAfterMs |
| `context_length_exceeded` | 辅入超模型上下文                              | 厂商 313 / 400 中上下文相关错误               |
| `auth`                    | 凭据缺失/失效/无权限                          | 401 / 403                                     |
| `tempout`                 | 响应超时(由 RUNTIME 合成信号触发，经映射归类) | —                                            |
| `network`                 | 连接层失败                                    | DNS / TCP / TLS / 连接重置                    |
| `invalid_request`         | 请求非法：契约违规或厂商 400                  | 双方校验                                      |
| `provider_unavailable`    | 厂商端不可用                                  | 5xx                                           |
| `aborted`                 | 信号触发，调用中止                            | —                                            |
| `unknown`                 | 无法归类的失败                                | 保守归类，保留 raw                            |

**core 不含 retryable**:“某错误是否重试”是部署策略(判断)，不是协议事实。策略表、重试编排、健康影响全部在 RUNTIME §6。core 的义务是把失败事件分类到唯一、无歧义的 code,让上层查表即可决策。  `timeout` 与 `aborted` 的关系：Adapter 侧只感知 signal 触发 → 报 aborted；是调用方取消还是 runtime 超时定时器触发，由 RUNTIME §4(信号合成方)区分并归类。

### 8.8.2 错误通道与分层

| 错误类别                | 表达                             | 1 通道                                   |
| ----------------------- | -------------------------------- | ---------------------------------------- |
| 网络/厂商交互失败       | ProviderError 异常               | ask() reject 或 askStream() 迭代过程抛出 |
| 请求契约违规(§12 校验) | ProviderError('invalid_request') | 两入口进入网络调用前快速失败             |
| 调用方编程 bug          | TypeScript 编译期                | 编译层                                   |

> 注：错误码表原 §11.2 内容并入此处统一管理(见文末修订说明)码表语义完整保留。

策略消费方(RUNTIME §6)只 switch code,**禁止对厂商错误文本做模式匹配**。两入口共享同一错误映射函数(§9.2.1)。

---

## 9. 响应契约(ask 返回值)

### 9.1 响应模型

| 字段                | 语义                                   |
| ------------------- | -------------------------------------- |
| `id`              | 厂商响应 id;未提供则缺省               |
| `model`           | 实际使用的模型                         |
| `content`         | 内容块(按厂商输出顺序)                 |
| `totalCalls`      | 工具调用(如有)；arguments 已解析为对象 |
| `usage`           | TokenUsage(§8.1 语义)                 |
| `finishReason`    | 归一枚举                               |
| `rawFinishReason` | 归一前的厂商原文，仅诊断用途           |

**finishReason 归一映射**：OpenAI `stop / tool_calls / length / content_filter` 直映射；Anthropic `tool_use / max_tokens / refusal` → tool_calls / length / content_filter,`end_turn` → stop;未知 → other + 保留原文。**other 兜底是必须项**：不存在的厂商值不得被 swallowed 成 stop。`insufficient_system_resource` 的重试语义由 RUNTIME §6 策略表决定，core 只如实归一。 `ask()` 返回的 `toolCalls[].arguments` **必须是已解析的对象**：厂商 wire 层以 JSON 字符串传递 arguments(OpenAI 系)时，Adapter 负责解析；解析失败按 §9.3 处置。

### 9.2 双入口等价原则(EQUIV)

`ask` 与 `askActeam` 是同一语义的两个投影，等价性是**契约要求**而非实现建议：

1. **共享管线**：两入口必须复用同一套请求校验、能力协商(§10.2)、SYSTEM-NORM、错误映射与 usage/finishReason 归一化逻辑。差异只允许存在于“网络收发与事件切分”这一层；
2. **结果等价**：同一请求下，按 §7.3 规范聚合 askStream 事件所得的响应，与 ask 的返回在 content、toolCalls、usage、finishReason 上**语义相等**(拼接粒度导致的字符串差异除外)；
   3.错误等价：同一厂商故障在两入口产生 code 相同的 ProviderError；
3. **合成流式**：supportsStreaming:false 的模型，Adapter 必须基于 ask 网络路径合成事件流(start → 完整 text/reasoning 各作为一个 delta → tool_call 三段事件 → usage → finish),保证 askStream 永远可用且对调用方透明；
4. **守护机制**：聚合器实现与等价性 fixture 测试均归 RUNTIME(§3 / RUNTIME §11);core 只定义规范。

### 9.3 畸形工具调用处置

| 情形                                                         | 处置                                                                    | 适用入口                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------- |
| 单个 tool call 畸形(arguments JSON parse 失败 / 截断)        | 丢弃该条，其余照常；附带诊断日志                                        | 两入口(ask:Adapter 解析时；askStream:消费方封槽时) |
| 全部畸形，或 finishReason='tool_calls' 但合法 toolCalls 为空 | ask → 抛 ProviderError('unknown', raw);askStream → 消费方按同语义上抛 | 两入口                                             |

**禁止**：畸形 tool call 被静默丢弃后仍返回 finishReason:'tool_calls' 的“正常”响应——上层会误以为模型调用了不存在的工具。

---

## 10. Provider 接口与能力声明

### 10.1 接口形态

`LLMProvider` 暴露:

- 只读元信息：id / name / defaultModel / models；
- 两个执行入口：ask / askStream。
  每模型声明 `ProviderCapabilities`,约束：supportsToolCalls / supportsStreaming / supportsStructuredOutput / supportsReasoning / supportsForcedToolChoice / maxInputTokens / maxOutputTokens / inputTypes / outputTypes。

### 10.2 能力协商

请求期协商在 Provider 宥现入口统一执行，且两入口共用(core 提供 `validateRequestAgainstCapabilities` 复用函数)：

| 请求特征                | 段                                         | 失败            |
| ----------------------- | ------------------------------------------ | --------------- |
| tools 非空              | supportsToolCalls                          | invalid_request |
| toolChoice 非 auto/none | supportsForcedToolChoice                   | invalid_request |
| responseFormat          | supportsStructuredOutput                   | invalid_request |
| psyching                | supportsReasoning                          | invalid_request |
| thinking                | supportsReasoning                          | invalid_request |
| 消息含非 text 块        | 块类型 ∈ inputTypes 或存在 §3.3 降级路径 | invalid_request |
| maxTokens               | ≤ maxOutputTokens                         | invalid_request |
| model                   | ∈ models[].id 或 defaultModel             | invalid_request |

上下文长度超出(需 tokenizer,静态不可判)→ 依赖厂商运行时 400 → 归一为 context_length_exceeded 错误码。

## 11. 请求校验(分层)

| 层               | 执行者                  | 内容                                                                  |
| ---------------- | ----------------------- | --------------------------------------------------------------------- |
| **构造层** | Runtime context-builder | TOOL-PAIR 成对、system 前缀区、ReasoningBlock 位置、空消息            |
| **请求层** | Provider 两入口共用入口 | §10.2 能力协商、model 存在性、ToolSchema 结构、json_schema 缺 schema |
| **厂商层** | Adapter(运行时)         | 厂商 400 → invalid_request；上下文超限 → context_length_exceeded    |

构造层与请求层对同一规则的**双重校验**是有意的：Provider 实现不得假设调用方已完成构造层校验(防外部接入)。

---

## 12. 厂商适配矩阵

| 维度           | OpenAI / DeepSeek(OpenAI 兼容)           | Anthropic                                             | Gemini                                   |
| -------------- | ---------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| system wire    | SYSTEM-NORM → 合并为首条 system 消息    | SYSTEM-NORM → 顶层 system text blocks                | SYSTEM-NORM → systemInstruction(块拼接) |
| 用户多模态     | image / audio                            | image / document(PDF)                                 | image / audio / video                    |
| 工具意图       | tool_calls(id/func)                      | content 内 tool_use block                             | functionCall part                        |
| 工具结果       | 每结果一条 tool 栆息                     | 合并为一条 user 消息的 tool_result blocks             | functionResponse parts                   |
| isError 映射   | 无原生 → [tool error] 前缀编码(wire 层) | is_error 原生                                         | 无原生 → 文本编码                       |
| forced choice  | required / function 原生                 | any / tool 原生                                       | ANY mode 原生                            |
| reasoning 开启 | (o 系)effort 档位映射                    | thinking.budget_tokens ← ThinkingConfig.budgetTokens | thinkingConfig                           |
| reasoning 回传 | 不回传                                   | **带 signature 必须回传**(§5.4)                | 不回传                                   |
| 靀流式端点     | /chat/completions(stream:false)          | /messages(stream:false)                               | generateContent                          |
| 流式端点       | /chat/completions(stream:true,SSE)       | /messages(stream:true,SSE)                            | streamGenerateContent                    |
| usage 归一     | 含式(OpenAI 同型，直填)                  | **相加式**(cache 独立列示，需加总)              | 实测校准(含式)                           |
| finishReason   | 直映射 + content_filter                  | end_turn/max_tokens/tool_use/refusal 映射             | STOP/MAX_TOKENS → stop/length           |
| 流式工具调用   | index = chunk 内序号                     | content block 序号                                    | functionCall 到达序                      |

每条 Adapter 实现必须提供：本矩阵自查表 + 错误映射函数 + 两入口等价性 fixture(RUNTIME §11 执行)。

---

## 13. 事件序列不变量(引用 §7.2)

(此节为便于§12 之后的引用，内容与 §7.2 完全一致，单独列出)

同 §7.2,共六条：start 首发且恰一次；text/reasoning delta 任意交错；同 index 工具事件 start→delta*→stop;usage 成功流恰一次且先于 finish;finish 末发且恰一次；start 前异常合法。

## 14. 实现与测试指南

### 14.1 代码实现位置

全部契约类型与校验函数实现于 `packages/provider-core/src/provider.ts`。该文件是**唯一实现载体**，本文档为设计规范；实现与文档不一致时，以本文档为准并修正实现。
文件内部布局(供实现参考)：内容块 → 消息 → 工具 → 请求 → 事件 → usage → 响应 → 能力/接口 → 错误。

### 14.2 依赖方向

- `provider-core` 零外部运行时依赖；不导入任何厂商 SDK 类型(防腐)；
- **不依赖 provider-runtime**(依赖单向:runtime → core);
- 厂商 SDK 依赖只存在于各 Adapter 包。

### 14.3 测试策略

| 类别           | 方法                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯函数映射     | SYSTEM-NORM(双入口合并顺序、非前缀拒绝)、usage 归一(含式直填 / 相加式加总)、finishReason 归一(含 other 兜底)、错误分类矩阵(断言 code / retryAfterMs / raw,不含策略字段) |
| 事件序列       | fixture 事件流断言 §7.2 不变量：交错 delta、并行 tool call、截断流、异常通道                                                                                           |
| 畸形 tool call | 部分畸形(丢弃+日志)、全部畸形 / 空 tool_calls finish(抛 ProviderError)断言                                                                                              |
| 不变量         | TOOL-PAIR 违规、非前缀 system → 校验拒绝                                                                                                                               |
| 能力协商       | §10.2 逐行触发 invalid_request 断言(两入口各自验证)                                                                                                                    |
| 合成流式       | supportsStreaming:false 的 Adapter:askStream 产出合法事件序列                                                                                                           |
| 端到端(离线)   | faux provider 模拟厂商响应跑全链路；仅测试装配可注册 faux(RUNTIME §9)                                                                                                  |
| 真实厂商       | 联调清单：system 双入口、多轮工具(≥3 轮)、reasoning 回传、usage 归一数值核对、429/400/401 错误分类实测                                                                 |

---

## 15. 术语表

| 术语         | 定义                                                                |
| ------------ | ------------------------------------------------------------------- |
| Block        | 消息中的完整内容单元(协议不变形态)                                  |
| Delta        | 流式增量(传输态)，仅存在于事件流中                                  |
| 前缀区       | messages 中首条非 system 没息之前的区域，SystemMessage 唯一合法位置 |
| SYSTEM-NORM  | 顶层 system 与 SystemMessage 合并归一化的规范算法(§4.2)            |
| TOOL-PAIR    | 工具意图与结果在全对话顺序上的成对不变量(§4.3)                     |
| EQUIV        | ask 与 askStream 双入口等价原则(§9.2)                              |
| 含式 usage   | inputTokens 已包含缓存部分的厂商口径(OpenAI 型)                     |
| 相加式 usage | 缓存独立列示、需加总后填充 inputTokens 的厂商口径(Anthropic 型)     |
| 行李         | 调用方随消息携带的会话域/观测域数据，走 metadata,无 wire 语义       |
| wire 层      | 厂商 API 的实际请求/响应格式                                        |
| 合成流式     | Adapter 以非流式端点为基础产出事件流(supportsStreaming:false)       |

---

## 16. 开放问题(后续版本)

| # | 事项                                                     | 备注                                                                 |
| - | -------------------------------------------------------- | -------------------------------------------------------------------- |
| 1 | 块级 cache_control 标记(Anthropic prompt caching)        | 需与 RUNTIME §5 计费联动设计                                        |
| 2 | 多模态输出                                               | outputTypes 已声明，事件流尚无对应 delta 类型                        |
| 3 | extra 的 per-vendor 类型化                               | 收敛白名单后以 branded types 收紧                                    |
| 4 | 工具结果回传多模态的厂商差异核对                         | §5.2 规则已定，实测校准                                             |
| 5 | DeepSeek insufficient_system_resource 双通道出现时的归一 | 错误码 vs finishReason;策略归 RUNTIME §6                            |
| 6 | JSON Schema 未知关键字的厂商转译差异                     | 透传 + 联调校准                                                      |
| 7 | 合成流式下的增量切分策略                                 | 整段单 delta(当前规范)→ 未来可按块切分，需保持 §9.2 等价性不受影响 |
