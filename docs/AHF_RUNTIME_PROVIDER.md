
# Provider Runtime 设计

|                    |                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------- |
| **文档 ID**  | PROVIDER-RUNTIME                                                                       |
| **版本**     | v1.0                                                                                   |
| **状态**     | 定稿(实现依据)                                                                         |
| **适用范围** | `provider-runtime` 包：聚合、编排(限流/超时/重试/failover)、计价、画像、健康度、装配 |
| **依赖**     | `provider-core`(单向；本文档以 `[CORE §x]` 引用其规范条款)                        |

---

## 1. 概述

### 1.1 职责

provider-runtime 是 core 契约之上的**判断层与观测层**：core 报告发生了什么，runtime 决定怎么办、并量出结果。具体包括：

1. **聚合**：实现 `[CORE §7.3]` 规范的事件流聚合；
2. **编排**：选路执行一轮调用的完整生命周期(限流 → 超时/信号合成 → 调用 → 聚合 → 打点 → 错误处置)；
3. **判断**：重试 / failover / 熔断决策(策略表驱动，`[CORE §8.8]` 错误码为唯一输入)；
4. **观测**：时序打点(TTFT / e2e)、滚动性能画像、健康分；
5. **经济**：从 `[CORE §8]` usage 事实派生成本(定价表 + 分时档位)、经济画像；
6. **装配**：providers.json 配置、Adapter 注册、启动校验、faux 防线、画像持久化。

### 1.2 与 core 的边界速查

| 维度   | core(事实/规范)                                                                           | runtime(判断/测量)                           |
| ------ | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| 错误   | `code`、`retryAfterMs`(厂商披露)                                                      | 是否重试、退避多久、是否换家、健康扣多少     |
| usage  | 口径归一后的 token 事实(`inputTokens` 全量含缓存、`cachedInputTokens ⊆ inputTokens`) | 单价、档位、成本金额、经济画像               |
| 事件流 | 序列不变量、聚合语义规范                                                                  | 聚合实现、TTFT / e2e 打点、百分位画像        |
| signal | 透传并报`aborted`                                                                       | 超时定时器合成、区分 timeout / caller-cancel |
| 能力   | `ProviderCapabilities`(静态事实)                                                        | 限额、路由预过滤、failover 目标筛选          |
| 消息   | wire 语义字段                                                                             | 行李(metadata 约定)、trace 透传              |

### 1.3 设计原则

1. **策略外置可替换**：重试/健康/退避的全部数值集中在策略表对象，默认值随包提供，部署可覆盖，不散落在代码分支里；
2. **一切统计从 core 事实派生**：画像、成本、健康的输入只有事件流 + `usage` 事件 + `ProviderError`,无第二真相源；
3. **降级有守卫**：每个统计指标都有样本量守卫，样本不足时显式降级到粗粒度画像，不出现“零样本指标参与决策”；
4. **编排路径唯一**：一轮 LLM 调用只经过 RoundExecutor 一条路径，打点/计费/画像不会因调用入口不同而漂移。

---

## 2. 架构与数据流

```
┌──────────────────────────────────────────────────────────────┐
│                        Runtime 装配层                          │
│  providers.json ──启动校验──▶ ProviderRegistry(Adapter 实例)   │
│  ProfileStore(冷启动加载)──▶ 画像初值                          │
├──────────────────────────────────────────────────────────────┤
│  RoundExecutor(编排,§4)                                      │
│  选路候选 → Limiter 限流 → 信号合成 → 调用 → StreamAggregator  │
│        ▲                                    │                  │
│        │ RetryPolicy + Failover + 熔断(§6)  ▼                  │
│  HealthTracker(§8)◀── RoundMetrics ── Pricer(§5)              │
│        │                                    │                  │
│        ▼                                    ▼                  │
│  路由供给接口(§10)          ProfileCollector(§7)              │
├──────────────────────────────────────────────────────────────┤
│  [CORE 契约] LLMProvider.ask / askStream                       │
│  Adapter × N(OpenAI / Anthropic / Gemini / openai-compat)     │
└──────────────────────────────────────────────────────────────┘
```

一轮调用的生命周期(RoundExecutor):

```
execute(request, strategy):
  1. 选路得到候选序列 [(provider, model), …]           ← 路由域输入
  2. for candidate in 候选:
       limiter.acquire(providerId, estInputTokens)      §4.3
       signal = compose(callerSignal, timeout(policy))   §4.2
       stream = provider.askStream(req)                 (或 ask,见 §4.1)
       round = aggregate(stream, timers)                §3
       cost = pricer.cost(round.usage, model.pricing)    §5
       emit RoundMetrics → 画像/健康/账本                 §7/§8
       成功 → 返回 round
       失败 → retryPolicy.decide(error)                  §6
              → 本地重试(同 candidate)/ 换下一 candidate / 冒泡
```

---

## 3. StreamAggregator(实现 `[CORE §7.3]` 规范)

core 不提供聚合函数，聚合的**实现在本包**；规范语义(拼接顺序、槽位封槽、畸形处置)由 `[CORE §7.3 / §9.3]` 定义，本节实现不得偏离。

### 3.1 接口形态

```ts
/** runtime 提供的唯一聚合实现;Executor/测试复用,禁止各自手写 */
export function aggregateStream(
    events: AsyncIterable<StreamCompletionEvent>,
    timers: RoundTimers,
): Promise<AggregatedRound>;
export interface RoundTimers {
    /** ask/askStream 发起时刻(打点基准) */
    startedAt: number;
    /** 首个内容事件(text/reasoning/tool_call delta)到达时刻;聚合器写入 */
    firstEventAt?: number;
    /** finish 到达或异常时刻;聚合器写入 */
    endedAt?: number;
}
export interface AggregatedRound {
    response: LLMResponse;       // 按 [CORE §7.3] 规则产出
    ttftMs?: number;             // firstEventAt − startedAt
    totalMs: number;             // endedAt − startedAt
}
```

### 3.2 聚合规则(逐条对应 `[CORE §7.3]`)

1. text_delta 按到达顺序拼接 → 单个 TextBlock;reasoning_delta 拼接 → 单个 ReasoningBlock;二者按**到达顺序**排列(厂商先出 reasoning 后出文本则顺序如实反映)；
2. tool call 按 `index` 分组:`start` 建立 `(callId, name)` 槽位；delta 按到达顺序做**字符串拼接**;`stop` 封槽；封槽后对拼接结果 `JSON.parse` → `ToolCall`;
3. 空 content 且无 toolCalls → 以 TextBlock("")占位(下游无需判空)；
4. usage / finishReason / id 从对应事件提取；
5. `start` 前收到异常 → 该轮次无任何结果，异常按 `[CORE §8.8]` 分类上抛。

### 3.3 畸形工具调用处置(对齐 `[CORE §9.3]`)

| 情形                                                                                             | 处置                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 单个 tool call 畸形(JSON parse 失败 / 截断)                                                      | 丢弃该条，其余照常；附带诊断日志                                       |
| 全部畸形，或`finishReason='tool_calls'` 但合法 toolCalls 为空                                  | 抛`ProviderError('unknown', raw)`——按可重试语义上抛，交由 §6 决策 |
| **禁止**：畸形 tool call 被静默丢弃后仍产出 `finishReason:'tool_calls'` 的“正常”响应。 |                                                                        |

### 3.4 序列不变量校验

聚合器对输入事件流断言 `[CORE §7.2]` 六条不变量(start 恰一次且首发、finish 恰一次且末发、usage 恰一次、同 index 的 `start → delta* → stop`、finish 前无未封槽、finish 后无事件)；违规抛 `ProviderError('invalid_request')`——视为上游 Adapter bug,快速暴露而非容错吞掉。core 已提供 `EventSequenceValidator` 断言器，聚合器直接复用。

### 3.5 双入口等价守护(EQUIV)

- 测试侧用 `aggregateStream` 聚合 Adapter 的 `askStream` 事件，与 `ask` 返回逐字段比对(content / toolCalls / usage / finishReason),守护 `[CORE §9.2]`;
- `ask()` 路径无流可聚合，TTFT 不可测(见 §4.1)。

---

## 4. RoundExecutor 与打点

### 4.1 调用入口选择

| 场景                                                                                                                                             | 入口          | 可测时序     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------ |
| 需要增量输出 / 需要时序画像的流量(默认)                                                                                                          | `askStream` | TTFT + total |
| 纯批量、无增量需求                                                                                                                               | `ask`       | 仅 total     |
| 统一建议走`askStream`:时序画像(TTFT 百分位)依赖流式事件到达;`supportsStreaming:false` 的模型由 Adapter 合成流(`[CORE §9.2.3]`),行为一致。 |               |              |

### 4.2 信号合成

```ts
function composeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal;
```

- runtime 定时器触发 → core 层报 `aborted`(`[CORE §8.8.1]`);runtime **自己知道**是定时器触发，归类为 `timeout`(进策略表、计健康)；调用方 signal 触发 → 归类为 `aborted`(不计错误率、不降健康)。事实在 core,判断在此处完成；
- `timeoutMs` 来自 provider 配置(§9.1),模型级可覆盖。

### 4.3 Limiter(端点级共享限额)

同一 provider(同一 key / 端点)下的**全部兄弟模型共享**一份限额：

```ts
export interface ProviderLimits {
    /** 每分钟请求数(令牌桶,容量 = rpm,匀速回填) */
    rpm?: number;
    /** 每分钟 token 数:请求前按预估输入 acquire,完成后按实际 usage 结算修正 */
    tpm?: number;
    /** 并发在途请求数(信号量) */
    concurrency?: number;
}
export interface Limiter {
    /** 阻塞直至获得额度;acquire 失败前检查熔断状态 */
    acquire(providerId: string, estimatedInputTokens: number): Promise<void>;
    /** 轮次结束后按实际 token 修正账目 */
    settle(providerId: string, actualUsage: TokenUsage): void;
}
```

TPM 为**记账式估计**：预估输入(消息字符数 / 4 的粗估)acquire,完成后按 `[CORE §8]` 的 `inputTokens` settle 修正差额。这是已知近似(开放问题 §15)。

### 4.4 RoundMetrics(打点事件，观测/计费/画像的唯一汇入点)

```ts
export interface RoundMetrics {
    providerId: string;
    modelId: string;
    ok: boolean;
    finishReason?: LLMFinishReason;
    /** [CORE §8] 归一后事实(全量口径:inputTokens 含缓存) */
    usage?: TokenUsage;
    /** §5 派生 */
    costUsd?: number;
    /** §3 打点 */
    ttftMs?: number;
    totalMs: number;
    errorCode?: ProviderErrorCode;
    /** 含重试的总尝试次数 */
    attempts: number;
    /** §4.2 判断结果 */
    abortedBy: 'caller' | 'timeout' | null;
    /** faux 轮次标记:不进画像/账本(§9.3) */
    synthetic?: boolean;
    at: number;
}
```

---

## 5. 计价

### 5.1 定价模型(模型级)

```ts
export type CostComponent = 'input' | 'output' | 'cache-write' | 'cache-read' | 'reasoning';
export interface PricingSchedule {
    currency: 'USD';
    base: {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheWritePerMTok?: number;
        cacheReadPerMTok?: number;
        reasoningPerMTok?: number;
    };
    tiers: PricingTier[];
    effectiveAt: number;
    version: string;
}
export interface PricingTier {
    name: string;
    /** UTC 小时,半开区间 [start, end);start > end 表示跨午夜(如 [22,6) = 22:00–06:00) */
    windowHoursUtc: [number, number];
    /** > 0;0.5 = 半价 */
    multiplier: number;
    /** 缺省 = 作用于全部成分 */
    appliesTo?: CostComponent[];
}
```

### 5.2 成本公式

基于 `[CORE §8]` 的全量口径 usage(`inputTokens` 含缓存命中、`cachedInputTokens ⊆ inputTokens`、`reasoningTokens ⊆ outputTokens`),派生各计费成分：

```
CR = usage.cachedInputTokens ?? 0     // 缓存命中部分(⊆ inputTokens)
R  = usage.reasoningTokens ?? 0       // 推理部分(⊆ outputTokens)
units['input']      = (usage.inputTokens ?? 0) − CR
units['cache-read'] = CR
units['cache-write'] = 0              // core usage 未暴露独立写入量,按 0 计,见开放问题
if pricing.base.reasoningPerMTok 已定义:      // 拆分语义
    units.output    = (usage.outputTokens ?? 0) − R
    units.reasoning = R
else:                                          // 并入语义(不叠加、不双计)
    units.output    = (usage.outputTokens ?? 0)
    units.reasoning = 0
cost = Σ_component  tierMultiplier(请求时刻UTC小时, component)
                 × unitPrice(component) × units(component) / 1e6
```

计费属于判断层的派生操作(扣减、拆分均在本层完成)；core 只供给无歧义的全量事实。未报告的 usage 字段按 0 计(`[CORE §8.2]` 语义)。

### 5.3 档位匹配规则

1. **per-component first-match**:对每个计费成分独立扫描 tiers,取第一个「窗口命中 **且** `appliesTo` 覆盖该成分(或缺省)」的档位；无命中 → multiplier 1.0(即 base);
2. 跨午夜命中条件:`h >= start || h < end`(当 start > end);否则 `start <= h < end`;
3. 校验(启动，§9.2):`start === end` 非法；小时 ∈ 0–23;`multiplier > 0`;窗口不覆盖 24h 合法(回落 base)。

### 5.4 账本

`BillingLedger` 订阅 RoundMetrics,按 usage 事实逐笔追加。本期为进程内累计 + 周期落盘，不做对账，仅供给经济画像(§7.2)与用户账单展示。
----------------------------------------------------------------------------------------------------------------------

## 6. 重试、Failover 与熔断

### 6.1 RetryPolicy(决策表，可整体替换)

```ts
export interface RetryDecision {
    /** 本地(同 candidate)重试次数上限 */
    localRetries: number;
    /** 退避基数;rate_limit 优先取厂商 retryAfterMs */
    backoff: 'none' | 'exponential';
    /** 本地重试耗尽后是否切换下一 candidate */
    failover: boolean;
    /** 健康分影响(§8) */
    healthImpact: number;
    /** 是否计入错误率统计 */
    countsAsError: boolean;
}
export type RetryPolicyTable = Readonly<Record<ProviderErrorCode, RetryDecision>>;
```

**默认表**：

| code                        | localRetries | backoff                        | failover | healthImpact | countsAsError | 备注                                            |
| --------------------------- | ------------ | ------------------------------ | -------- | ------------ | ------------- | ----------------------------------------------- |
| `rate_limit`              | 2            | max(retryAfterMs, 1s→4s 指数) | ✓       | −2          | ✓            | 厂商存活，惩罚轻                                |
| `context_length_exceeded` | 0            | —                             | ✓       | 0            | ✗            | 换长上下文模型，非厂商问题                      |
| `auth`                    | 0            | —                             | ✓       | 置 0(硬)     | ✓            | 摘除端点 + 告警                                 |
| `timeout`                 | 1            | 2s                             | ✓       | −8          | ✓            |                                                 |
| `network`                 | 2            | 1s→4s + jitter                | ✓       | −10         | ✓            |                                                 |
| `invalid_request`         | 0            | —                             | ✗       | 0            | ✗            | 我方 bug,直接冒泡                               |
| `provider_unavailable`    | 1            | —                             | ✓       | −15         | ✓            |                                                 |
| `aborted`                 | 0            | —                             | ✗       | 0            | ✗            | §4.2 已分流：timeout 定时器触发的按 timeout 行 |
| `unknown`                 | 1            | 2s                             | ✓       | −5          | ✓            | 采样日志，逐步归纳                              |
| **特殊通道**：        |              |                                |          |              |               |                                                 |

- **finishReason 通道**:`insufficient_system_resource`(DeepSeek)不是 error,但策略上按 `provider_unavailable` 行处理(可重试换家)；聚合器在 RoundMetrics 中如实上报 finishReason,编排层查表；
- 整轮最大尝试次数 `maxAttempts`(默认 4,候选数 × 本地重试的总上限)封顶，防雪崩。

### 6.2 熔断器(端点级)

| 状态                                                                       | 进入条件                                          | 行为                                                   | 退出                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| closed                                                                     | 初始                                              | 正常放行                                               | —                                             |
| open                                                                       | 健康分 < 30**或** 连续 5 次 failover 类失败 | Limiter.acquire 直接拒绝该 provider 的请求(不发起网络) | 冷却 30s 后转 half-open                        |
| half-open                                                                  | 冷却结束                                          | 放行单个探测请求                                       | 成功 → closed(健康 +20);失败 → open 重计冷却 |
| failover 候选序列由路由域供给；本层只负责“这个 candidate 现在能不能用”。 |                                                   |                                                        |                                                |

---

## 7. 画像

### 7.1 性能画像(模型级，滚动窗口)

```ts
export interface Percentile { p50: number; p90: number; p95: number; p99?: number; }
export interface PerformanceProfile {
    /** outputTokens / (totalMs − ttftMs) */
    tokensPerSecond: Percentile;
    ttftMs: Percentile;
    e2eLatencyMs: Percentile;
    /** countsAsError 的失败占比 */
    errorRate: number;
    /** 工具轮次 arguments 可解析且被调用方接受的比例 */
    toolCallSchemaCompliance: number;
    sampleSize: number;
    /** 默认 3_600_000 */
    windowMs: number;
    lastUpdated: number;
}
```

### 7.2 经济画像(模型级，含 tag 细分)

```ts
export interface EconomicsProfile {
    avgTaskCostUsd: number;
    avgTokensPerTurn: { input: number; output: number };
    /** cost / 平均评估分;qualitySampleSize = 0 时为"无数据",路由降级(§7.3) */
    costPerQualityScore: number;
    qualitySampleSize: number;
    retryRate: number;
    sampleSize: number;
    perTag?: Partial<Record<SpecialtyTag, TagEconomics>>;
    lastUpdated: number;
}
export interface TagEconomics {
    avgTokensPerTurn: { input: number; output: number };
    avgTaskCostUsd: number;
    successRate: number;
    /** < 30 时该 tag 维度回退到模型整体画像 */
    sampleSize: number;
}
/** 语义路由标签;开放枚举 + 共享常量治理(§9.2 启动校验抓 typo) */
export type SpecialtyTag =
    | 'frontend-ui-generation' | 'code-refactoring' | 'data-analysis'
    | 'creative-writing' | 'math-reasoning' | 'summarization'
    | 'translation' | 'long-document-analysis' | 'scenario-dialogue'
    | 'scientific-research' | 'multimodal-understanding'
    | 'tool-use-reliability' | 'fast-classification'
    | (string & {});
```

### 7.3 样本守卫与降级链

1. `sampleSize < 30` → 性能/经济画像整体降权(路由侧读取 `sampleSize` 自行降权，画像层不做隐藏填充)；
2. `perTag[tag].sampleSize < 30` → 回退模型整体画像；
3. `qualitySampleSize === 0` → `costPerQualityScore` 视为无数据：路由降级到 `avgTaskCostUsd + errorRate + retryRate` 组合，**禁止零样本除零或 0 分污染**；
4. 质量信号源为 P2 占位：

```ts
export interface QualitySignalSource {
    sample(modelId: string): Promise<QualitySample | null>;
}
export interface QualitySample {
    score: number;
    at: number;
    source: 'user-feedback' | 'judge';
}
```

### 7.4 ProfileStore(持久化)

```ts
export interface ProfileSnapshot {
    models: Record<string /* providerId/modelId */, {
        performance: PerformanceProfile;
        economics: EconomicsProfile;
    }>;
    savedAt: number;
}
export interface ProfileStore {
    load(): Promise<ProfileSnapshot | null>;
    save(snapshot: ProfileSnapshot): Promise<void>;
}
```

- 文件实现(`.mazi/profiles.json`);窗口滚动 / 进程退出时快照；
- 冷启动加载：丢弃超出 `windowMs` 的过期部分;`sampleSize` 不足照常触发降权，但不从零烧起；
- faux provider 的数据一律不落盘(§9.3)。

---

## 8. 健康度

```ts
export interface HealthTracker {
    /** 起始 100,上限 100,下限 0;查询接口供给路由 */
    score(providerId: string): number;
}
```

规则(数值均在 §6.1 表，可替换)：

1. 每次成功轮次 +1(缓慢恢复);`auth` 失败直接置 0(端点级硬摘除)；
2. 失败按 `healthImpact` 扣减;`aborted`(caller)与 `invalid_request` 零影响；
3. 半开探测成功 +20(§6.2);
4. 健康分是 failover 与熔断的输入，**不是**路由评分的组成部分(避免厂商暂时抖动与长期质量偏好混在一个数里)。

---

## 9. 装配：配置、注册与启动校验

### 9.1 配置模型

**Provider = 端点**(凭据、baseUrl、超时、共享限额)，**模型 = 画像载体**(id、name、capabilities、pricing):

```jsonc
{
  "providers": [
    {
      "id": "openai-main",
      "adapter": "openai",
      "apiKeyEnv": "OPENAI_API_KEY",          // 缺省走 adapter 默认 env 映射
      "timeoutMs": 120000,
      "limits": { "rpm": 60, "tpm": 90000, "concurrency": 8 },
      "models": [
        {
          "id": "gpt-4o",
          "name": "gpt-4o",
          "timeoutMs": 60000,                 // 可选:模型级覆盖
          "capabilities": {
            "supportsToolCalls": true,
            "supportsStreaming": true,
            "supportsReasoning": false,
            "inputTypes": ["text", "image"]
          },
          "pricing": {
            "currency": "USD",
            "base": { "inputPerMTok": 2.5, "outputPerMTok": 10 },
            "tiers": [],
            "effectiveAt": 0,
            "version": "v1"
          }
        }
      ]
    },
    {
      "id": "gw-cn",
      "adapter": "openai",                    // openai 兼容网关
      "baseUrl": "https://gw.example.com/v1",
      "apiKeyEnv": "GW_CN_KEY"
    }
  ]
}
```

`baseUrl` 为一等字段：OpenAI 兼容网关(oneapi / newapi / 各厂兼容端点)是主流接入形态，不支持即配置向导半残。

### 9.2 启动校验(`validateProviderConfig`)

**硬失败(进程 abort)**:

- `adapter` 未知或缺失;`type:'faux'` 且未被允许(§9.3);
- `modelId` 在 provider 内重复；`capabilities` 形状非法；`pricing.base` 各单价 ≤ 0;`multiplier ≤ 0`;`windowHours` 越界或 start === end;
- `limits` 非正数;`timeoutMs ≤ 0`;
- `apiKeyEnv` 显式配置且当前 env 缺失(显式声明 = 声明意图，缺失属于配置错误)。
  **警告(不阻塞)**:
- adapter 无默认 env 映射且未配置 `apiKeyEnv`(本地端点/无鉴权网关，不校验)；
- specialty tag 不在 `KNOWN_SPECIALTIES` 常量集(列出候选，抓 typo);
- `perTag` 存在模型未声明的孤儿 tag。
  请求期 `validateRequestAgainstCapabilities`(`[CORE §10.2 / §12]`)在运行时仍兜底执行(防外部接入)，启动不重复。

### 9.3 faux 防线

- `ProviderRegistry` 构造参数 `allowFaux: boolean`;生产装配固定 `false`,providers.json 含 faux → 启动失败；
- 仅测试装配与 `MAZI_ALLOW_FAUX=1`(显式演示模式)可注册；
- faux 轮次的 RoundMetrics 标记 synthetic:不进 ProfileStore、不进 BillingLedger。

### 9.4 ProviderRegistry

```ts
export interface ProviderRegistry {
    /** 未注册 → 抛装配错误 */
    get(providerId: string): LLMProvider;
    list(): LLMProvider[];
}
```

Adapter 实例化:`adapter` 字段 → 工厂(注入 apiKey / baseUrl / timeout);凭据只从 env 读取，**不落配置文件与仓库**。
-----------------------------------------------------------------------------------------------------

## 10. 路由供给接口(边界出口)

本包不实现路由评分算法(策略域)，只暴露供给查询：

```ts
export interface RoutingSupply {
    models(): Array<{
        providerId: string;
        modelId: string;
        /** [CORE] */
        capabilities: ProviderCapabilities;
        /** §5 */
        pricing: PricingSchedule;
        /** 样本不足为 null */
        performance: PerformanceProfile | null;
        economics: EconomicsProfile | null;
        /** §8 端点级 */
        health: number;
        /** §6.2 */
        breakerOpen: boolean;
    }>;
}
```

约定：**null = 无数据**，不返回零填充的伪画像；降级链(§7.3)由路由策略执行。
------------------------------------------------------------------------

## 11. 文件布局

```
packages/provider-runtime/src/
├── aggregate.ts      # StreamAggregator(实现 [CORE §7.3])
├── orchestrator.ts   # RoundExecutor:限流→信号合成→调用→聚合→打点
├── retry.ts          # RetryPolicyTable 默认表 + 决策执行 + 熔断器
├── limiter.ts        # RPM/TPM 令牌桶 + 并发信号量(端点级)
├── pricing.ts        # PricingSchedule、tier 匹配、cost 计算、BillingLedger
├── profile.ts        # Performance/Economics 滚动画像 + ProfileCollector
├── health.ts         # HealthTracker
├── registry.ts       # ProviderRegistry、Adapter 工厂、faux 防线
├── config.ts         # providers.json schema、启动校验、KNOWN_SPECIALTIES
├── store.ts          # ProfileStore(文件实现)
├── supply.ts         # RoutingSupply
└── index.ts
```

依赖:`provider-runtime` → `provider-core`(唯一内部依赖)；不 import 任何厂商 SDK(经 core 契约与 Adapter 实例交互)。
----------------------------------------------------------------------------------

## 12. 测试策略

| 类别                               | 方法                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EQUIV([CORE §9.2] 守护)** | 测试侧用`aggregateStream` 聚合 Adapter 的 `askStream` 事件，与 `ask` 返回逐字段比对(content/toolCalls/usage/finishReason);含多轮工具、reasoning、多 system 段场景 |
| 聚合器                             | fixture 事件流 → AggregatedRound 断言；畸形 tool call(部分/全部);序列不变量违规拒绝;TTFT/total 打点                                                                    |
| 计价                               | reasoning 有/无单价拆分、per-component tier、跨午夜、无命中回落 base、缓存子集语义(inputTokens − cachedInputTokens 派生)、未报告字段按 0                               |
| 策略表                             | 每个 code 的 decision 断言(含 insufficient_system_resource 的 finishReason 通道)；退避序列;maxAttempts 封顶                                                             |
| 熔断                               | open/half-open/closed 转移;`auth` 置 0;健康恢复速率                                                                                                                   |
| 限流                               | 令牌桶回填节奏、TPM 预估-结算修正、端点级共享(兄弟模型打满同一桶)                                                                                                       |
| 画像                               | 窗口滚动淘汰、样本守卫降级链(含 qualitySampleSize=0)、perTag 回退、快照往返一致、过期样本剔除、faux 不落盘                                                              |
| 装配                               | §9.2 硬失败逐条触发；警告文案；faux 拦截与 env 放行                                                                                                                    |
| 端到端(离线)                       | faux provider 走完整 RoundExecutor(重试换家、健康降分、成本入账)                                                                                                        |

---

## 13. 术语表

| 术语           | 定义                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| Round          | 一次完整的 LLM 调用(含重试/attempts)                                           |
| RoundMetrics   | 一轮的打点事件，观测/计费/画像的唯一汇入点(§4.4)                              |
| 决策表         | `code → RetryDecision` 的可替换策略表(§6.1)                                |
| 记账式 TPM     | 请求前按预估 acquire、完成后 settle 修正的 token 限额近似(§4.3)               |
| 合成流式       | Adapter 以非流式端点产出事件流(`[CORE]`)                                     |
| candidate      | failover 序列中的一个(provider, model)候选项                                   |
| 降级链         | 样本不足时统计指标显式回退粗粒度的顺序(§7.3)                                  |
| 全量口径 usage | `[CORE §8]` 的 inputTokens/outputTokens 均为总量、缓存/推理为子集维度的语义 |

---

## 14. 与 core 的条款对应表(双向可追溯)

| runtime 条款             | 实现的 core 规范                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| §3 StreamAggregator     | `[CORE §7.3]` 聚合语义、`[CORE §9.3]` 畸形处置、`[CORE §7.2]` 序列不变量(复用 core 断言器) |
| §4.2 信号合成           | `[CORE §8.8.1]` timeout/aborted 分工                                                             |
| §4.3 Limiter.settle     | `[CORE §8]` inputTokens 全量口径                                                                 |
| §4.4 RoundMetrics.usage | `[CORE §8]` 归一后事实                                                                           |
| §5 Pricer               | `[CORE §8.1]` 子集语义的计费消费方(派生在本层完成)                                               |
| §6 RetryPolicy          | `[CORE §8.8.2]` 错误码语义表(策略在此，core 无 retryable)                                        |
| §6.1 finishReason 通道  | `[CORE §9.1]` insufficient_system_resource                                                       |
| §9.2 请求期兜底         | `[CORE §10.2 / §12]` 分层校验                                                                   |
| §12 EQUIV               | `[CORE §9.2]`                                                                                    |

---

## 15. 开放问题(后续版本)

| # | 事项                                                    | 备注                                                                                                                                       |
| - | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | TPM 预估精度(字符数/4)                                  | 可引入共享 tokenizer;当前近似够用                                                                                                          |
| 2 | 质量信号源接线(用户反馈 / LLM-as-judge)                 | `QualitySignalSource` 已占位;接入后 `costPerQualityScore` 生效                                                                         |
| 3 | prompt caching 的成本优化决策(何时主动加 cache_control) | 依赖`[CORE]` 块级标记扩展                                                                                                                |
| 4 | cache-write 计量的 usage 供给                           | core 当前仅`cachedInputTokens`(读);若需 Anthropic 写入量计费，core 需扩展 `cachedWriteInputTokens ⊆ inputTokens`,runtime 公式同步启用 |
| 5 | failover 候选排序的联合策略(健康 × 画像 × 价格)       | 路由策略域，仅经 §10 供给接口消费                                                                                                         |
| 6 | 账本对账与配额(月度上限熔断)                            | BillingLedger 目前只累计                                                                                                                   |
| 7 | 多区域/多 key 同厂商的水平分摊                          | 同一 vendor 多 provider 实例 + 独立限额即可表达，选路策略待路由域                                                                          |

---

本版修整内容：补全缺失的 §3(StreamAggregator,含聚合规则、畸形处置、序列不变量复用与 EQUIV 守护)；将 §4.1/§5.3/§6.1/§6.2/§9.2/§9.3/§10 中被误并入表格单元格的段落恢复为独立正文；usage 术语与字段对齐修正后的 core 契约(`inputTokens` 全量含缓存、`cachedInputTokens ⊆ inputTokens`、`reasoningTokens` 命名)，§5.2 成本公式改为全量口径派生并将 cache-write 计量缺口登记为开放问题;`[CORE §11]` 引用统一更新为 `[CORE §8.8]`。

# Provider Runtime 设计

|                    |                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------- |
| **文档 ID**  | PROVIDER-RUNTIME                                                                       |
| **版本**     | v1.0                                                                                   |
| **状态**     | 定稿(实现依据)                                                                         |
| **适用范围** | `provider-runtime` 包：聚合、编排(限流/超时/重试/failover)、计价、画像、健康度、装配 |
| **依赖**     | `provider-core`(单向；本文档以 `[CORE §x]` 引用其规范条款)                        |

---

## 1. 概述

### 1.1 职责

provider-runtime 是 core 契约之上的**判断层与观测层**：core 报告发生了什么，runtime 决定怎么办、并量出结果。具体包括：

1. **聚合**：实现 `[CORE §7.3]` 规范的事件流聚合；
2. **编排**：选路执行一轮调用的完整生命周期(限流 → 超时/信号合成 → 调用 → 聚合 → 打点 → 错误处置)；
3. **判断**：重试 / failover / 熔断决策(策略表驱动，`[CORE §8.8]` 错误码为唯一输入)；
4. **观测**：时序打点(TTFT / e2e)、滚动性能画像、健康分；
5. **经济**：从 `[CORE §8]` usage 事实派生成本(定价表 + 分时档位)、经济画像；
6. **装配**：providers.json 配置、Adapter 注册、启动校验、faux 防线、画像持久化。

### 1.2 与 core 的边界速查

| 维度   | core(事实/规范)                                                                           | runtime(判断/测量)                           |
| ------ | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| 错误   | `code`、`retryAfterMs`(厂商披露)                                                      | 是否重试、退避多久、是否换家、健康扣多少     |
| usage  | 口径归一后的 token 事实(`inputTokens` 全量含缓存、`cachedInputTokens ⊆ inputTokens`) | 单价、档位、成本金额、经济画像               |
| 事件流 | 序列不变量、聚合语义规范                                                                  | 聚合实现、TTFT / e2e 打点、百分位画像        |
| signal | 透传并报`aborted`                                                                       | 超时定时器合成、区分 timeout / caller-cancel |
| 能力   | `ProviderCapabilities`(静态事实)                                                        | 限额、路由预过滤、failover 目标筛选          |
| 消息   | wire 语义字段                                                                             | 行李(metadata 约定)、trace 透传              |

### 1.3 设计原则

1. **策略外置可替换**：重试/健康/退避的全部数值集中在策略表对象，默认值随包提供，部署可覆盖，不散落在代码分支里；
2. **一切统计从 core 事实派生**：画像、成本、健康的输入只有事件流 + `usage` 事件 + `ProviderError`,无第二真相源；
3. **降级有守卫**：每个统计指标都有样本量守卫，样本不足时显式降级到粗粒度画像，不出现“零样本指标参与决策”；
4. **编排路径唯一**：一轮 LLM 调用只经过 RoundExecutor 一条路径，打点/计费/画像不会因调用入口不同而漂移。

---

## 2. 架构与数据流

```
┌──────────────────────────────────────────────────────────────┐
│                        Runtime 装配层                          │
│  providers.json ──启动校验──▶ ProviderRegistry(Adapter 实例)   │
│  ProfileStore(冷启动加载)──▶ 画像初值                          │
├──────────────────────────────────────────────────────────────┤
│  RoundExecutor(编排,§4)                                      │
│  选路候选 → Limiter 限流 → 信号合成 → 调用 → StreamAggregator  │
│        ▲                                    │                  │
│        │ RetryPolicy + Failover + 熔断(§6)  ▼                  │
│  HealthTracker(§8)◀── RoundMetrics ── Pricer(§5)              │
│        │                                    │                  │
│        ▼                                    ▼                  │
│  路由供给接口(§10)          ProfileCollector(§7)              │
├──────────────────────────────────────────────────────────────┤
│  [CORE 契约] LLMProvider.ask / askStream                       │
│  Adapter × N(OpenAI / Anthropic / Gemini / openai-compat)     │
└──────────────────────────────────────────────────────────────┘
```

一轮调用的生命周期(RoundExecutor):

```
execute(request, strategy):
  1. 选路得到候选序列 [(provider, model), …]           ← 路由域输入
  2. for candidate in 候选:
       limiter.acquire(providerId, estInputTokens)      §4.3
       signal = compose(callerSignal, timeout(policy))   §4.2
       stream = provider.askStream(req)                 (或 ask,见 §4.1)
       round = aggregate(stream, timers)                §3
       cost = pricer.cost(round.usage, model.pricing)    §5
       emit RoundMetrics → 画像/健康/账本                 §7/§8
       成功 → 返回 round
       失败 → retryPolicy.decide(error)                  §6
              → 本地重试(同 candidate)/ 换下一 candidate / 冒泡
```

---

## 3. StreamAggregator(实现 `[CORE §7.3]` 规范)

core 不提供聚合函数，聚合的**实现在本包**；规范语义(拼接顺序、槽位封槽、畸形处置)由 `[CORE §7.3 / §9.3]` 定义，本节实现不得偏离。

### 3.1 接口形态

```ts
/** runtime 提供的唯一聚合实现;Executor/测试复用,禁止各自手写 */
export function aggregateStream(
    events: AsyncIterable<StreamCompletionEvent>,
    timers: RoundTimers,
): Promise<AggregatedRound>;
export interface RoundTimers {
    /** ask/askStream 发起时刻(打点基准) */
    startedAt: number;
    /** 首个内容事件(text/reasoning/tool_call delta)到达时刻;聚合器写入 */
    firstEventAt?: number;
    /** finish 到达或异常时刻;聚合器写入 */
    endedAt?: number;
}
export interface AggregatedRound {
    response: LLMResponse;       // 按 [CORE §7.3] 规则产出
    ttftMs?: number;             // firstEventAt − startedAt
    totalMs: number;             // endedAt − startedAt
}
```

### 3.2 聚合规则(逐条对应 `[CORE §7.3]`)

1. text_delta 按到达顺序拼接 → 单个 TextBlock;reasoning_delta 拼接 → 单个 ReasoningBlock;二者按**到达顺序**排列(厂商先出 reasoning 后出文本则顺序如实反映)；
2. tool call 按 `index` 分组:`start` 建立 `(callId, name)` 槽位；delta 按到达顺序做**字符串拼接**;`stop` 封槽；封槽后对拼接结果 `JSON.parse` → `ToolCall`;
3. 空 content 且无 toolCalls → 以 TextBlock("")占位(下游无需判空)；
4. usage / finishReason / id 从对应事件提取；
5. `start` 前收到异常 → 该轮次无任何结果，异常按 `[CORE §8.8]` 分类上抛。

### 3.3 畸形工具调用处置(对齐 `[CORE §9.3]`)

| 情形                                                                                             | 处置                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 单个 tool call 畸形(JSON parse 失败 / 截断)                                                      | 丢弃该条，其余照常；附带诊断日志                                       |
| 全部畸形，或`finishReason='tool_calls'` 但合法 toolCalls 为空                                  | 抛`ProviderError('unknown', raw)`——按可重试语义上抛，交由 §6 决策 |
| **禁止**：畸形 tool call 被静默丢弃后仍产出 `finishReason:'tool_calls'` 的“正常”响应。 |                                                                        |

### 3.4 序列不变量校验

聚合器对输入事件流断言 `[CORE §7.2]` 六条不变量(start 恰一次且首发、finish 恰一次且末发、usage 恰一次、同 index 的 `start → delta* → stop`、finish 前无未封槽、finish 后无事件)；违规抛 `ProviderError('invalid_request')`——视为上游 Adapter bug,快速暴露而非容错吞掉。core 已提供 `EventSequenceValidator` 断言器，聚合器直接复用。

### 3.5 双入口等价守护(EQUIV)

- 测试侧用 `aggregateStream` 聚合 Adapter 的 `askStream` 事件，与 `ask` 返回逐字段比对(content / toolCalls / usage / finishReason),守护 `[CORE §9.2]`;
- `ask()` 路径无流可聚合，TTFT 不可测(见 §4.1)。

---

## 4. RoundExecutor 与打点

### 4.1 调用入口选择

| 场景                                                                                                                                             | 入口          | 可测时序     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------ |
| 需要增量输出 / 需要时序画像的流量(默认)                                                                                                          | `askStream` | TTFT + total |
| 纯批量、无增量需求                                                                                                                               | `ask`       | 仅 total     |
| 统一建议走`askStream`:时序画像(TTFT 百分位)依赖流式事件到达;`supportsStreaming:false` 的模型由 Adapter 合成流(`[CORE §9.2.3]`),行为一致。 |               |              |

### 4.2 信号合成

```ts
function composeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal;
```

- runtime 定时器触发 → core 层报 `aborted`(`[CORE §8.8.1]`);runtime **自己知道**是定时器触发，归类为 `timeout`(进策略表、计健康)；调用方 signal 触发 → 归类为 `aborted`(不计错误率、不降健康)。事实在 core,判断在此处完成；
- `timeoutMs` 来自 provider 配置(§9.1),模型级可覆盖。

### 4.3 Limiter(端点级共享限额)

同一 provider(同一 key / 端点)下的**全部兄弟模型共享**一份限额：

```ts
export interface ProviderLimits {
    /** 每分钟请求数(令牌桶,容量 = rpm,匀速回填) */
    rpm?: number;
    /** 每分钟 token 数:请求前按预估输入 acquire,完成后按实际 usage 结算修正 */
    tpm?: number;
    /** 并发在途请求数(信号量) */
    concurrency?: number;
}
export interface Limiter {
    /** 阻塞直至获得额度;acquire 失败前检查熔断状态 */
    acquire(providerId: string, estimatedInputTokens: number): Promise<void>;
    /** 轮次结束后按实际 token 修正账目 */
    settle(providerId: string, actualUsage: TokenUsage): void;
}
```

TPM 为**记账式估计**：预估输入(消息字符数 / 4 的粗估)acquire,完成后按 `[CORE §8]` 的 `inputTokens` settle 修正差额。这是已知近似(开放问题 §15)。

### 4.4 RoundMetrics(打点事件，观测/计费/画像的唯一汇入点)

```ts
export interface RoundMetrics {
    providerId: string;
    modelId: string;
    ok: boolean;
    finishReason?: LLMFinishReason;
    /** [CORE §8] 归一后事实(全量口径:inputTokens 含缓存) */
    usage?: TokenUsage;
    /** §5 派生 */
    costUsd?: number;
    /** §3 打点 */
    ttftMs?: number;
    totalMs: number;
    errorCode?: ProviderErrorCode;
    /** 含重试的总尝试次数 */
    attempts: number;
    /** §4.2 判断结果 */
    abortedBy: 'caller' | 'timeout' | null;
    /** faux 轮次标记:不进画像/账本(§9.3) */
    synthetic?: boolean;
    at: number;
}
```

---

## 5. 计价

### 5.1 定价模型(模型级)

```ts
export type CostComponent = 'input' | 'output' | 'cache-write' | 'cache-read' | 'reasoning';
export interface PricingSchedule {
    currency: 'USD';
    base: {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheWritePerMTok?: number;
        cacheReadPerMTok?: number;
        reasoningPerMTok?: number;
    };
    tiers: PricingTier[];
    effectiveAt: number;
    version: string;
}
export interface PricingTier {
    name: string;
    /** UTC 小时,半开区间 [start, end);start > end 表示跨午夜(如 [22,6) = 22:00–06:00) */
    windowHoursUtc: [number, number];
    /** > 0;0.5 = 半价 */
    multiplier: number;
    /** 缺省 = 作用于全部成分 */
    appliesTo?: CostComponent[];
}
```

### 5.2 成本公式

基于 `[CORE §8]` 的全量口径 usage(`inputTokens` 含缓存命中、`cachedInputTokens ⊆ inputTokens`、`reasoningTokens ⊆ outputTokens`),派生各计费成分：

```
CR = usage.cachedInputTokens ?? 0     // 缓存命中部分(⊆ inputTokens)
R  = usage.reasoningTokens ?? 0       // 推理部分(⊆ outputTokens)
units['input']      = (usage.inputTokens ?? 0) − CR
units['cache-read'] = CR
units['cache-write'] = 0              // core usage 未暴露独立写入量,按 0 计,见开放问题
if pricing.base.reasoningPerMTok 已定义:      // 拆分语义
    units.output    = (usage.outputTokens ?? 0) − R
    units.reasoning = R
else:                                          // 并入语义(不叠加、不双计)
    units.output    = (usage.outputTokens ?? 0)
    units.reasoning = 0
cost = Σ_component  tierMultiplier(请求时刻UTC小时, component)
                 × unitPrice(component) × units(component) / 1e6
```

计费属于判断层的派生操作(扣减、拆分均在本层完成)；core 只供给无歧义的全量事实。未报告的 usage 字段按 0 计(`[CORE §8.2]` 语义)。

### 5.3 档位匹配规则

1. **per-component first-match**:对每个计费成分独立扫描 tiers,取第一个「窗口命中 **且** `appliesTo` 覆盖该成分(或缺省)」的档位；无命中 → multiplier 1.0(即 base);
2. 跨午夜命中条件:`h >= start || h < end`(当 start > end);否则 `start <= h < end`;
3. 校验(启动，§9.2):`start === end` 非法；小时 ∈ 0–23;`multiplier > 0`;窗口不覆盖 24h 合法(回落 base)。

### 5.4 账本

`BillingLedger` 订阅 RoundMetrics,按 usage 事实逐笔追加。本期为进程内累计 + 周期落盘，不做对账，仅供给经济画像(§7.2)与用户账单展示。
----------------------------------------------------------------------------------------------------------------------

## 6. 重试、Failover 与熔断

### 6.1 RetryPolicy(决策表，可整体替换)

```ts
export interface RetryDecision {
    /** 本地(同 candidate)重试次数上限 */
    localRetries: number;
    /** 退避基数;rate_limit 优先取厂商 retryAfterMs */
    backoff: 'none' | 'exponential';
    /** 本地重试耗尽后是否切换下一 candidate */
    failover: boolean;
    /** 健康分影响(§8) */
    healthImpact: number;
    /** 是否计入错误率统计 */
    countsAsError: boolean;
}
export type RetryPolicyTable = Readonly<Record<ProviderErrorCode, RetryDecision>>;
```

**默认表**：

| code                        | localRetries | backoff                        | failover | healthImpact | countsAsError | 备注                                            |
| --------------------------- | ------------ | ------------------------------ | -------- | ------------ | ------------- | ----------------------------------------------- |
| `rate_limit`              | 2            | max(retryAfterMs, 1s→4s 指数) | ✓       | −2          | ✓            | 厂商存活，惩罚轻                                |
| `context_length_exceeded` | 0            | —                             | ✓       | 0            | ✗            | 换长上下文模型，非厂商问题                      |
| `auth`                    | 0            | —                             | ✓       | 置 0(硬)     | ✓            | 摘除端点 + 告警                                 |
| `timeout`                 | 1            | 2s                             | ✓       | −8          | ✓            |                                                 |
| `network`                 | 2            | 1s→4s + jitter                | ✓       | −10         | ✓            |                                                 |
| `invalid_request`         | 0            | —                             | ✗       | 0            | ✗            | 我方 bug,直接冒泡                               |
| `provider_unavailable`    | 1            | —                             | ✓       | −15         | ✓            |                                                 |
| `aborted`                 | 0            | —                             | ✗       | 0            | ✗            | §4.2 已分流：timeout 定时器触发的按 timeout 行 |
| `unknown`                 | 1            | 2s                             | ✓       | −5          | ✓            | 采样日志，逐步归纳                              |
| **特殊通道**：        |              |                                |          |              |               |                                                 |

- **finishReason 通道**:`insufficient_system_resource`(DeepSeek)不是 error,但策略上按 `provider_unavailable` 行处理(可重试换家)；聚合器在 RoundMetrics 中如实上报 finishReason,编排层查表；
- 整轮最大尝试次数 `maxAttempts`(默认 4,候选数 × 本地重试的总上限)封顶，防雪崩。

### 6.2 熔断器(端点级)

| 状态                                                                       | 进入条件                                          | 行为                                                   | 退出                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| closed                                                                     | 初始                                              | 正常放行                                               | —                                             |
| open                                                                       | 健康分 < 30**或** 连续 5 次 failover 类失败 | Limiter.acquire 直接拒绝该 provider 的请求(不发起网络) | 冷却 30s 后转 half-open                        |
| half-open                                                                  | 冷却结束                                          | 放行单个探测请求                                       | 成功 → closed(健康 +20);失败 → open 重计冷却 |
| failover 候选序列由路由域供给；本层只负责“这个 candidate 现在能不能用”。 |                                                   |                                                        |                                                |

---

## 7. 画像

### 7.1 性能画像(模型级，滚动窗口)

```ts
export interface Percentile { p50: number; p90: number; p95: number; p99?: number; }
export interface PerformanceProfile {
    /** outputTokens / (totalMs − ttftMs) */
    tokensPerSecond: Percentile;
    ttftMs: Percentile;
    e2eLatencyMs: Percentile;
    /** countsAsError 的失败占比 */
    errorRate: number;
    /** 工具轮次 arguments 可解析且被调用方接受的比例 */
    toolCallSchemaCompliance: number;
    sampleSize: number;
    /** 默认 3_600_000 */
    windowMs: number;
    lastUpdated: number;
}
```

### 7.2 经济画像(模型级，含 tag 细分)

```ts
export interface EconomicsProfile {
    avgTaskCostUsd: number;
    avgTokensPerTurn: { input: number; output: number };
    /** cost / 平均评估分;qualitySampleSize = 0 时为"无数据",路由降级(§7.3) */
    costPerQualityScore: number;
    qualitySampleSize: number;
    retryRate: number;
    sampleSize: number;
    perTag?: Partial<Record<SpecialtyTag, TagEconomics>>;
    lastUpdated: number;
}
export interface TagEconomics {
    avgTokensPerTurn: { input: number; output: number };
    avgTaskCostUsd: number;
    successRate: number;
    /** < 30 时该 tag 维度回退到模型整体画像 */
    sampleSize: number;
}
/** 语义路由标签;开放枚举 + 共享常量治理(§9.2 启动校验抓 typo) */
export type SpecialtyTag =
    | 'frontend-ui-generation' | 'code-refactoring' | 'data-analysis'
    | 'creative-writing' | 'math-reasoning' | 'summarization'
    | 'translation' | 'long-document-analysis' | 'scenario-dialogue'
    | 'scientific-research' | 'multimodal-understanding'
    | 'tool-use-reliability' | 'fast-classification'
    | (string & {});
```

### 7.3 样本守卫与降级链

1. `sampleSize < 30` → 性能/经济画像整体降权(路由侧读取 `sampleSize` 自行降权，画像层不做隐藏填充)；
2. `perTag[tag].sampleSize < 30` → 回退模型整体画像；
3. `qualitySampleSize === 0` → `costPerQualityScore` 视为无数据：路由降级到 `avgTaskCostUsd + errorRate + retryRate` 组合，**禁止零样本除零或 0 分污染**；
4. 质量信号源为 P2 占位：

```ts
export interface QualitySignalSource {
    sample(modelId: string): Promise<QualitySample | null>;
}
export interface QualitySample {
    score: number;
    at: number;
    source: 'user-feedback' | 'judge';
}
```

### 7.4 ProfileStore(持久化)

```ts
export interface ProfileSnapshot {
    models: Record<string /* providerId/modelId */, {
        performance: PerformanceProfile;
        economics: EconomicsProfile;
    }>;
    savedAt: number;
}
export interface ProfileStore {
    load(): Promise<ProfileSnapshot | null>;
    save(snapshot: ProfileSnapshot): Promise<void>;
}
```

- 文件实现(`.mazi/profiles.json`);窗口滚动 / 进程退出时快照；
- 冷启动加载：丢弃超出 `windowMs` 的过期部分;`sampleSize` 不足照常触发降权，但不从零烧起；
- faux provider 的数据一律不落盘(§9.3)。

---

## 8. 健康度

```ts
export interface HealthTracker {
    /** 起始 100,上限 100,下限 0;查询接口供给路由 */
    score(providerId: string): number;
}
```

规则(数值均在 §6.1 表，可替换)：

1. 每次成功轮次 +1(缓慢恢复);`auth` 失败直接置 0(端点级硬摘除)；
2. 失败按 `healthImpact` 扣减;`aborted`(caller)与 `invalid_request` 零影响；
3. 半开探测成功 +20(§6.2);
4. 健康分是 failover 与熔断的输入，**不是**路由评分的组成部分(避免厂商暂时抖动与长期质量偏好混在一个数里)。

---

## 9. 装配：配置、注册与启动校验

### 9.1 配置模型

**Provider = 端点**(凭据、baseUrl、超时、共享限额)，**模型 = 画像载体**(id、name、capabilities、pricing):

```jsonc
{
  "providers": [
    {
      "id": "openai-main",
      "adapter": "openai",
      "apiKeyEnv": "OPENAI_API_KEY",          // 缺省走 adapter 默认 env 映射
      "timeoutMs": 120000,
      "limits": { "rpm": 60, "tpm": 90000, "concurrency": 8 },
      "models": [
        {
          "id": "gpt-4o",
          "name": "gpt-4o",
          "timeoutMs": 60000,                 // 可选:模型级覆盖
          "capabilities": {
            "supportsToolCalls": true,
            "supportsStreaming": true,
            "supportsReasoning": false,
            "inputTypes": ["text", "image"]
          },
          "pricing": {
            "currency": "USD",
            "base": { "inputPerMTok": 2.5, "outputPerMTok": 10 },
            "tiers": [],
            "effectiveAt": 0,
            "version": "v1"
          }
        }
      ]
    },
    {
      "id": "gw-cn",
      "adapter": "openai",                    // openai 兼容网关
      "baseUrl": "https://gw.example.com/v1",
      "apiKeyEnv": "GW_CN_KEY"
    }
  ]
}
```

`baseUrl` 为一等字段：OpenAI 兼容网关(oneapi / newapi / 各厂兼容端点)是主流接入形态，不支持即配置向导半残。

### 9.2 启动校验(`validateProviderConfig`)

**硬失败(进程 abort)**:

- `adapter` 未知或缺失;`type:'faux'` 且未被允许(§9.3);
- `modelId` 在 provider 内重复；`capabilities` 形状非法；`pricing.base` 各单价 ≤ 0;`multiplier ≤ 0`;`windowHours` 越界或 start === end;
- `limits` 非正数;`timeoutMs ≤ 0`;
- `apiKeyEnv` 显式配置且当前 env 缺失(显式声明 = 声明意图，缺失属于配置错误)。
  **警告(不阻塞)**:
- adapter 无默认 env 映射且未配置 `apiKeyEnv`(本地端点/无鉴权网关，不校验)；
- specialty tag 不在 `KNOWN_SPECIALTIES` 常量集(列出候选，抓 typo);
- `perTag` 存在模型未声明的孤儿 tag。
  请求期 `validateRequestAgainstCapabilities`(`[CORE §10.2 / §12]`)在运行时仍兜底执行(防外部接入)，启动不重复。

### 9.3 faux 防线

- `ProviderRegistry` 构造参数 `allowFaux: boolean`;生产装配固定 `false`,providers.json 含 faux → 启动失败；
- 仅测试装配与 `MAZI_ALLOW_FAUX=1`(显式演示模式)可注册；
- faux 轮次的 RoundMetrics 标记 synthetic:不进 ProfileStore、不进 BillingLedger。

### 9.4 ProviderRegistry

```ts
export interface ProviderRegistry {
    /** 未注册 → 抛装配错误 */
    get(providerId: string): LLMProvider;
    list(): LLMProvider[];
}
```

Adapter 实例化:`adapter` 字段 → 工厂(注入 apiKey / baseUrl / timeout);凭据只从 env 读取，**不落配置文件与仓库**。
-----------------------------------------------------------------------------------------------------

## 10. 路由供给接口(边界出口)

本包不实现路由评分算法(策略域)，只暴露供给查询：

```ts
export interface RoutingSupply {
    models(): Array<{
        providerId: string;
        modelId: string;
        /** [CORE] */
        capabilities: ProviderCapabilities;
        /** §5 */
        pricing: PricingSchedule;
        /** 样本不足为 null */
        performance: PerformanceProfile | null;
        economics: EconomicsProfile | null;
        /** §8 端点级 */
        health: number;
        /** §6.2 */
        breakerOpen: boolean;
    }>;
}
```

约定：**null = 无数据**，不返回零填充的伪画像；降级链(§7.3)由路由策略执行。
------------------------------------------------------------------------

## 11. 文件布局

```
packages/provider-runtime/src/
├── aggregate.ts      # StreamAggregator(实现 [CORE §7.3])
├── orchestrator.ts   # RoundExecutor:限流→信号合成→调用→聚合→打点
├── retry.ts          # RetryPolicyTable 默认表 + 决策执行 + 熔断器
├── limiter.ts        # RPM/TPM 令牌桶 + 并发信号量(端点级)
├── pricing.ts        # PricingSchedule、tier 匹配、cost 计算、BillingLedger
├── profile.ts        # Performance/Economics 滚动画像 + ProfileCollector
├── health.ts         # HealthTracker
├── registry.ts       # ProviderRegistry、Adapter 工厂、faux 防线
├── config.ts         # providers.json schema、启动校验、KNOWN_SPECIALTIES
├── store.ts          # ProfileStore(文件实现)
├── supply.ts         # RoutingSupply
└── index.ts
```

依赖:`provider-runtime` → `provider-core`(唯一内部依赖)；不 import 任何厂商 SDK(经 core 契约与 Adapter 实例交互)。
----------------------------------------------------------------------------------

## 12. 测试策略

| 类别                               | 方法                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EQUIV([CORE §9.2] 守护)** | 测试侧用`aggregateStream` 聚合 Adapter 的 `askStream` 事件，与 `ask` 返回逐字段比对(content/toolCalls/usage/finishReason);含多轮工具、reasoning、多 system 段场景 |
| 聚合器                             | fixture 事件流 → AggregatedRound 断言；畸形 tool call(部分/全部);序列不变量违规拒绝;TTFT/total 打点                                                                    |
| 计价                               | reasoning 有/无单价拆分、per-component tier、跨午夜、无命中回落 base、缓存子集语义(inputTokens − cachedInputTokens 派生)、未报告字段按 0                               |
| 策略表                             | 每个 code 的 decision 断言(含 insufficient_system_resource 的 finishReason 通道)；退避序列;maxAttempts 封顶                                                             |
| 熔断                               | open/half-open/closed 转移;`auth` 置 0;健康恢复速率                                                                                                                   |
| 限流                               | 令牌桶回填节奏、TPM 预估-结算修正、端点级共享(兄弟模型打满同一桶)                                                                                                       |
| 画像                               | 窗口滚动淘汰、样本守卫降级链(含 qualitySampleSize=0)、perTag 回退、快照往返一致、过期样本剔除、faux 不落盘                                                              |
| 装配                               | §9.2 硬失败逐条触发；警告文案；faux 拦截与 env 放行                                                                                                                    |
| 端到端(离线)                       | faux provider 走完整 RoundExecutor(重试换家、健康降分、成本入账)                                                                                                        |

---

## 13. 术语表

| 术语           | 定义                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| Round          | 一次完整的 LLM 调用(含重试/attempts)                                           |
| RoundMetrics   | 一轮的打点事件，观测/计费/画像的唯一汇入点(§4.4)                              |
| 决策表         | `code → RetryDecision` 的可替换策略表(§6.1)                                |
| 记账式 TPM     | 请求前按预估 acquire、完成后 settle 修正的 token 限额近似(§4.3)               |
| 合成流式       | Adapter 以非流式端点产出事件流(`[CORE]`)                                     |
| candidate      | failover 序列中的一个(provider, model)候选项                                   |
| 降级链         | 样本不足时统计指标显式回退粗粒度的顺序(§7.3)                                  |
| 全量口径 usage | `[CORE §8]` 的 inputTokens/outputTokens 均为总量、缓存/推理为子集维度的语义 |

---

## 14. 与 core 的条款对应表(双向可追溯)

| runtime 条款             | 实现的 core 规范                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| §3 StreamAggregator     | `[CORE §7.3]` 聚合语义、`[CORE §9.3]` 畸形处置、`[CORE §7.2]` 序列不变量(复用 core 断言器) |
| §4.2 信号合成           | `[CORE §8.8.1]` timeout/aborted 分工                                                             |
| §4.3 Limiter.settle     | `[CORE §8]` inputTokens 全量口径                                                                 |
| §4.4 RoundMetrics.usage | `[CORE §8]` 归一后事实                                                                           |
| §5 Pricer               | `[CORE §8.1]` 子集语义的计费消费方(派生在本层完成)                                               |
| §6 RetryPolicy          | `[CORE §8.8.2]` 错误码语义表(策略在此，core 无 retryable)                                        |
| §6.1 finishReason 通道  | `[CORE §9.1]` insufficient_system_resource                                                       |
| §9.2 请求期兜底         | `[CORE §10.2 / §12]` 分层校验                                                                   |
| §12 EQUIV               | `[CORE §9.2]`                                                                                    |

---

## 15. 开放问题(后续版本)

| # | 事项                                                    | 备注                                                                                                                                       |
| - | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | TPM 预估精度(字符数/4)                                  | 可引入共享 tokenizer;当前近似够用                                                                                                          |
| 2 | 质量信号源接线(用户反馈 / LLM-as-judge)                 | `QualitySignalSource` 已占位;接入后 `costPerQualityScore` 生效                                                                         |
| 3 | prompt caching 的成本优化决策(何时主动加 cache_control) | 依赖`[CORE]` 块级标记扩展                                                                                                                |
| 4 | cache-write 计量的 usage 供给                           | core 当前仅`cachedInputTokens`(读);若需 Anthropic 写入量计费，core 需扩展 `cachedWriteInputTokens ⊆ inputTokens`,runtime 公式同步启用 |
| 5 | failover 候选排序的联合策略(健康 × 画像 × 价格)       | 路由策略域，仅经 §10 供给接口消费                                                                                                         |
| 6 | 账本对账与配额(月度上限熔断)                            | BillingLedger 目前只累计                                                                                                                   |
| 7 | 多区域/多 key 同厂商的水平分摊                          | 同一 vendor 多 provider 实例 + 独立限额即可表达，选路策略待路由域                                                                          |
