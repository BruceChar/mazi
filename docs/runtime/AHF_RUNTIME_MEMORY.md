# Runtime Memory 抽象设计

**状态**：实现对齐稿
**范围**：packages/runtime/src/memory/。定义 memory（调度策略）与 store（持久化端口）的边界，并把“长期记忆 ↔ context”的调度接到上一轮的 ContextManager。

## 1. 概念边界

**store ≠ memory**：

- **store**：与数据库/文件/向量库等存储实体的交互。只做 append / recall / clear，不懂上下文预算，也不懂该注入什么。
- **memory**：上层调度策略。决定长期记忆里“召回什么、按什么预算裁剪、以什么形态注入 context”。

对应代码：

- packages/runtime/src/memory/store.ts：MemoryItem / MemoryQuery / MemoryStore（持久化端口）+ InMemoryMemoryStore。
- packages/runtime/src/memory/memory.ts：MemoryPolicy / recentMemoryPolicy + MemoryManager（调度策略组合根）。
- packages/runtime/src/memory/goal-store.ts：Goal/Task/Step 执行事实的持久化实现（既有，归属 store 侧）。

## 2. 数据模型

    interface MemoryItem {
      id: string;
      kind: "turn" | "summary" | "fact" | (string & {});
      text: string;
      role?: "user" | "assistant";   // kind=turn 时
      createdAt: number;
      rootGoalId?: string;
      conversationId?: string;
      tags?: readonly string[];
    }

    interface MemoryStore {
      append(items): Promise<void>;
      recall(query): Promise<readonly MemoryItem[]>;
      clear(query): Promise<void>;
    }

## 3. MemoryManager

- remember(items)：写入 store（空集直接跳过）。
- recall(input)：store.recall → policy.select；budgetTokens 可由 input 覆盖构造默认值。
- toContribution(items, { id })：把召回快照转成 ContextContribution——kind=turn 走 messages，summary/fact 走 systemPrompt 片段。
- prepareContribution(input, opts)：recall + toContribution 的组合。
- forget(query)：清 store（会话结束清理）。

默认策略 recentMemoryPolicy：按 createdAt 保序、按 id 去重（后者覆盖）、从最新往回填充 token 预算，最多 maxItems 条。

## 4. 接线

- HarnessRuntime 持有 MemoryManager；createGoalSession 把 Conversation 历史经 turnsToMemory 记入 memory（标 rootGoalId）。
- goal-strategy 在每个 Goal 开始时 recall + toContribution，作为 contributions 透传 executeTask；每个 Goal 结束后把本 Goal 的 user/assistant 轮次 remember。
- goal-executor 把 contributions 交给 ContextManager；context 不再直接接收 history。

## 5. 测试基线

| 文件 | 覆盖 |
| --- | --- |
| memory.test.ts | store append/recall/clear 与隔离；policy 去重/保序/limit/token 预算；turnsToMemory 保序与唯一 id；toContribution 的 message/system 分流；prepareContribution |
| goal-strategy.test.ts | 跨 Goal 共享记忆的 baseMessageCount 语义不变 |
| conversation-context.test.ts | 会话历史经 memory 注入后，diff 仍只含本步新增 |

## 6. 工具执行回填（长期记忆 ↔ context）

- **runtime**：goal-strategy 在每个 Goal 结束后，除 user/assistant 轮次外，还把 invocation Step 记为 kind=fact 的 memory：`已执行工具 <tool>(<args>) → <output>`。下一个 Goal/Task 的 ContextManager 通过 memory contribution 的 system 片段看到“已执行过”，避免重复调用——尤其是空输出成功、或 Harness 单轮收尾没有后续 LLM 轮次的情形。
- **API**：sessions.service.conversationHistory 读取一次 run 的 invocation Step，生成 `[已执行工具]` 摘要并入该轮 assistant 历史，使**跨会话**的 LLM 上下文保留“已执行”事实。
- **安全**：写入 memory/history 的是模型可见的观察文本（secret 已在网关断流为 voucher），不是原文。
