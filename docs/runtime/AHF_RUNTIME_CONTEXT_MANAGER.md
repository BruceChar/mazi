# Runtime ContextManager 设计

**状态**：实现对齐稿
**范围**：packages/runtime/src/harness/context-manager.ts。把 Task 执行中就地拼装的上下文（system prompt / messages / tool schema）收敛为一等抽象，并预留敏感内容断流端口。

## 1. 背景

现状：

- 消息拼装在 gts/goal-executor.ts::executeTask 内联完成：[...history, user(statement)]，每轮手动 append assistant / append tool；
- 上下文计量基线（上一轮 total / 消息条数 / taskId）散落在 harness/round-runner.ts，靠 resetBaselines() 跨 run 清零；
- harness/context-measure.ts 只负责算，没有任何“压缩”决策点；
- 敏感数据一旦进入 context 只有网关侧的秘密断流（V3 机制二），消息拼装这层没有防线。

## 2. 目标与非目标

**目标**

- G1 单一职责：上下文状态与拼装只由 ContextManager 负责，goal-executor 不再直接操作 messages。
- G2 动态组装：system prompt / 前置消息 / tool schema 可由多个 ContextContribution 动态贡献，按注册顺序求值。
- G3 计量内聚：跨轮 delta 基线由 ContextManager 持有，RoundRunner 不再维护 taskId 基线。
- G4 敏感断流：标记为 secret 的观察值不得以原文进入 messages，改为 authz 的 voucher（handle + 策展属性）；缺少断流端口即 fail-closed。
- G5 压缩决策点：暴露 shouldCompact，本版不实现自动压缩（裁剪项，见 V3 §11）。

**非目标**

- 不实现自动摘要/截断压缩；
- 不做敏感内容的自动识别（由调用方标注或由网关产出 voucher）；
- 不改变 Conversation/Goal 的持久化形态。

## 3. 公开 API

    interface ContextContribution {
      id: string;
      systemPrompt?(): string | undefined;
      messages?(): LLMMessage[];
      tools?(): ToolSchema[];
    }

    interface ContextSecretRef { handle: string; attributes: authz.SecretAttributes }
    interface SecretRedactor { redact(value: string): ContextSecretRef }

    class ContextManager {
      constructor(opts: {
        systemPrompt?: string;
        tools?: readonly ToolSchema[];
        history?: readonly LLMMessage[];
        contributions?: readonly ContextContribution[];
        redactor?: SecretRedactor;
        assistantTextMax?: number; // 默认 4000，保持既有回注截断
      });
      addContribution(c: ContextContribution): void;
      removeContribution(id: string): boolean;
      appendUser(text: string): void;
      appendAssistant(turn: ContextAssistantTurn): void;
      appendToolResults(results: readonly ContextToolObservation[]): void;
      messages(): LLMMessage[];
      systemPrompt(): string | undefined;
      tools(): ToolSchema[];
      baseMessageCount(): number;
      measure(contextWindow: number): RuntimeContextBreakdown; // 实现 round-types.ContextMeter
      shouldCompact(contextWindow: number, threshold?: number): boolean;
      reset(): void;
    }

**组装顺序**：[...history, ...contributions.messages(), ...dynamic]；baseMessageCount = history + contribution 消息数，供 delta 计量区分“本步新增”。

**敏感断流**：appendToolResults 对 sensitivity=secret 的观察值，先检测其是否已是 voucher；否则调用 redactor.redact 并以 { "$secretRef": handle, attributes } 形式回注。无 redactor 抛 SecretRedactionUnavailableError（原文绝不落 context）。

## 4. 接线

- gts/round-types.ts：ExecutorRoundContext.context?: ContextMeter（仅接口，避免与具体类耦合）。
- harness/round-runner.ts：ctx.context?.measure(window) 优先；否则退回无状态 measureContext（toc-analyst 等非 Task 调用方）；删除 lastContextTotal/lastMessageCount/lastTaskId 与 resetBaselines()。
- gts/goal-executor.ts：每 Task 建一个 ContextManager，所有拼装经它；新增 redactor?: SecretRedactor 依赖。
- harness/runtime.ts：移除 resetBaselines() 调用。

## 5. 测试基线

| 文件 | 覆盖 |
| --- | --- |
| context-manager.test.ts | 动态 prompt/messages/tools 组合与去重；append 顺序与 baseMessageCount；跨轮 delta；shouldCompact；secret 断流；缺 redactor fail-closed |
| goal-executor.test.ts | 既有回注/白名单/usage 行为不变 |
| goal-strategy.test.ts | 跨 Task 共享历史的 baseMessageCount 语义不变 |
