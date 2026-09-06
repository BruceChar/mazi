# Provider → Observer → Session/Turn/Step 实施设计

> 版本：v0.1
> 目的：在不引入存储 SPI/PostgreSQL 的前提下，明确 Provider、Observer 与 Session/Turn/Step 执行闭环的落地边界。

## 1. 范围

- 存储：保留 `MemoryStore` 抽象与 `SqliteMemoryStore` 本地实现；上层只面向抽象，下层可替换，但本期不实现 PostgreSQL/SPI 重构。
- Provider：由 `packages/provider-llm` 提供标准化的一次 LLM 轮次结果（文本、推理、工具调用、usage、finishReason、时序）。
- Observer：新增独立消费/观察能力，把工具执行结果转换为结构化观测载荷，供模型回注上下文。
- Session/Turn/Step：执行闭环保持现有结构；Executor 通过 Observer 生成观察 Step，不再硬编码原始回注。

## 2. Provider 向 Observer 提供的契约

一次 LLM 轮次由 Provider 层归一为 `LLMRound`：

```ts
export interface LLMRound {
    text: string;
    reasoning: string;
    toolCalls: { callId: string; toolName: string; arguments: Record<string, unknown> }[];
    vendorUsage?: VendorUsage;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
    driverError?: Error;
}
```

- 流式事件到 `LLMRound` 的聚合逻辑属于 Provider 层（provider-llm），Executor 不再自行散装累加；
- `ttftMs`/`totalMs` 由 Provider 层归一；
- `llm.response` / `tool.result` 等可观测事件继续由执行层携带三层 ID 发出。

## 3. Observer 契约

Observer 面向工具执行结果，输出结构化观察载荷：

```ts
export interface ObservationContext {
    sessionId: string;
    turnId: string;
    toolName: string;
    result: ToolExecutionResult;
}

export interface Observer {
    observeToolResult(ctx: ObservationContext): Promise<ObservationPayload>;
}
```

结构化规则：

1. 成功结果保留关键头部与尾部，超大内容不整体注入模型上下文；
2. 失败结果携带 `isError: true` 与稳定错误分类；
3. `ObservationPayload` 保留完整可审计内容，`contextContent` 只用于模型回注；
4. Observer 输出只改变观察 Step 的载荷，不改变权限/策略判断。

## 4. Session/Turn/Step 接入

Executor 执行工具后的流程调整为：

```text
tool.invoke → ToolExecutionResult
  → Observer.observeToolResult
  → observation Step（payload.contextContent 供模型读取，完整内容保留审计）
  → step 持久化 + tool.result 事件
```

Session/Turn/Step 数据模型、Checkpoint、事件三层 ID 不变。

## 5. 实施顺序

1. core/provider 契约：新增 `LLMRound` 与 `ObservationContext/Observer` 类型；
2. provider-llm：新增流式事件归一函数，Executor 接入；
3. 新建 `@mazi/observer`：结构化观察载荷实现与测试；
4. executor：替换观察 Step 生成逻辑；
5. 全量测试、构建与文档同步。

## 6. 实施状态

- 已完成：core 契约（`LLMRound`/`ObservationPayload.contextContent`/`Observer`）、provider-llm 流式轮次归一、`DefaultObserver`（结构化截断与错误分类）、Executor 接入与上下文回注、SQLite `MemoryStore` 抽象保留。
- 未做：存储 SPI/PostgreSQL；独立 Reflector 仍未实现。Observer 现同时覆盖工具结果与 LLM 文本/思考的上下文裁剪。
