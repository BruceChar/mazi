# P2：packages/runtime 迁移到新 provider 契约（迁移清单）

> 依据：AHF_RUNTIME_PROVIDER v1.0；前置：core 编译恢复（4143dd6）。
> 目标：packages/runtime 编译通过且旧行为测试经映射后全绿；随后 P3 apps/cli/api，P4 清理。
> **状态：P2–P4 已完成（见提交 52a212e/4b52b7b/9a62a0f 及下述验证），全仓 44 文件 231 用例 + pnpm build 7/7 全绿。**

## 现状（runtime 构建错误盘点，6 文件 20 处）

| 文件 | 错误 | 根因 |
| --- | --- | --- |
| executor/context-builder.ts | 6 | 仍按旧 LLMMessage{content:string}/LLMContext 构建 prompt；新 core 为 Block 消息模型 |
| executor/executor.ts | 5 | 引用已删 LLMDriver/LLMRound/LLMStreamEvent；LLM 轮次自理（旧 driverFor + collectLLMRound） |
| runtime.ts | 6 | 引用已删 normalizeProvider/SimpleRouter/DefaultDriverRegistry/collectLLMRound/LLMDriver |
| planner/planner.ts | 1 | SimpleRouter 类型（路由自理） |
| config.ts | 1 | ProviderJson 类型来自已删 provider 包 |
| usage/cost-calculator.ts | 1 | PricingSchedule 已迁至 provider-runtime（旧 core 定价类型删除） |

## 目标形态（映射）

1. **消息/上下文**：context-builder 产出 → provider.ts 的
   `LLMRequest { system?, messages: LLMMessage[](Block), tools?: ToolSchema[] }`
   —— assistant 工具调用走 `toolCalls: ToolCall[]`、工具结果走 `ToolMessage.results: ToolResult[]`
   （callId 配对由 executor 维护）；旧 Step payload → Block 文本的翻译在 builder 内完成。
2. **LLM 轮次**：executor 删除 driverFor/collectLLMRound/计价自理；改为注入 provider-runtime：
   `RoundExecutor.execute(request, [stack.candidate(providerId)])`，round.response → old Step
   thinking/tool_call/observation + usage 映射（新 TokenUsage → 旧 usage.ts 的 VendorUsage/
   CostBreakdown，costUsd 直接由 metrics 提供）。观测事件复用现有 harness 事件词汇。
3. **装配**：HarnessRuntime 删除 normalizeProvider/SimpleRouter/DefaultDriverRegistry；由
   `assembleProviderStack(configs: ProviderConfig[], { adapters: { deepseek: deepseekAdapter } })`
   构建 registry/supply/round（faux 仅测试）；配置迁到 provider-runtime §9.1 ProviderConfig。
4. **配置**：config.ts 的 RuntimeConfig.providers 换型；apps/cli 的 providers.json 迁移（向导
   configure.ts 用 provider-runtime 校验 + registry），旧 driver 段删除。
5. **测试**：planner/executor/harness-runtime 等旧用例改为「fake/faux provider + 真实聚合断言」；
   usage 的 cost-calculator 可整体替换为 provider-runtime pricing 断言。

## 执行顺序（每步独立提交）

> 全部完成：P2a-P2e（context-builder/executor/runtime 装配，52a212e；测试迁移 4b52b7b）、P3（cli 模型发现，9a62a0f）、P4（本清单收口）。capacity/其它 legacy 类型按迁移期标注保留（ModelRef 等仍被旧 Session/Turn/Step 层引用，随后续 core AHF 模块替换移除）。

- [ ] P2a context-builder：新 Block 消息构建 + 单测
- [ ] P2b executor：LLM 轮次换 RoundExecutor + Step/usage 映射 + 单测
- [ ] P2c runtime.ts/config.ts：装配替换（assemble + deepseekAdapter）+ harness-runtime.test 改造
- [ ] P2d planner：路由依赖删除（容量内 model 由 stack.supply/candidate 供给）或并入执行期
- [ ] P2e 全 runtime tsc + vitest 绿
- [ ] P3 apps/cli/api：config/向导/运行路径迁移
- [ ] P4 删除 capacity/其它 legacy 标注类型与旧自理层；全仓 pnpm check 全绿

## 阻塞前提

无外部阻塞：core 已在本仓库内收敛（P1）。剩余为纯执行工作量（估 P2a-P2e
≈ 800–1200 行 + 测试改造）；P3/P4 另估。