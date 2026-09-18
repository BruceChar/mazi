# Runtime 确定性输出单轮收尾设计

**状态**：实现对齐稿
**范围**：packages/runtime/src/gts/deterministic-finalize.ts，以及 gts/goal-executor.ts 的收尾分支与 general.prompt.ts 的模板契约。

## 1. 背景

现状：模型每轮只能“先给工具调用，等结果回来再发起下一轮 LLM 请求”才能产出最终答案。对确定性链路（天气查询、`ls` 等直接命令）这是多余的一次往返，既慢又可能因为空结果而反复重试。

## 2. 目标

- 模型可以在**同一条回复**里同时给出最终答案模板与工具调用；harness 执行工具后用结果填充模板直接输出，不再请求 LLM。
- 直接命令（`ls` 等）由模型用 `{{result}}` 模板声明“工具输出即最终答案”。
- 空成功输出仍上报 `[ok] (no output)`，并在提示中明确“不要因空结果重试”。

## 3. 模板契约

- `{{result}}`：单个工具结果；多个结果时按顺序用空行拼接。
- `{{result:1}}` / `{{result:2}}`：按 1 基序号取结果。
- `{{result:<toolName>}}`：按工具名取（同名多个则拼接）。

收尾条件（全部满足才收尾，否则走原有循环）：
1. 模板含至少一个 `{{result...}}` 占位符；
2. 本轮所有工具调用都成功（无 `isError`）；
3. 所有占位符都能被结果填满（无 unresolved）。

## 4. 记录与展示

- deliberation Step 的 `payload.answer` 更新为渲染后的最终答案，并新增 `payload.answerTemplate` 保留模型原始模板（可审计、可回放）。
- invocation Step 仍按既有流程逐条落库工具调用与输出。

## 5. 测试基线

| 文件 | 覆盖 |
| --- | --- |
| deterministic-finalize.test.ts | 占位符识别、单/多结果替换、序号与工具名、unresolved 判定、失败不收尾 |
| goal-executor.test.ts | 模板+工具调用 → 单轮收尾且不再 requestRound；deliberation.answer/answerTemplate；unresolved/失败时不收尾 |

## 6. 重试收尾（防止空结果循环）

针对“收到 [ok] (no output) 后模型再次发起工具调用”的循环，goal-executor 增加两道护栏：

1. **同调用去重**：以 toolName + 参数指纹记录本轮 Task 内已成功执行过的调用；再次出现时不真正执行，直接把已有结果回给模型（invocation Step 仍落库，标记为 replay）。
2. **重试收尾**：若某一轮的工具调用**全部**是 replay 且模型本轮没有文本，直接用已有结果合成最终答案并结束（全为空成功时给“已完成（命令执行成功，无输出）。”），不再请求下一轮。

另外把原来的“连续 3 轮相同调用 → 任务失败”改为**优雅收尾**：以模型本轮文本（无则“已完成。”）作为最终答案，避免把未收敛直接判失败。

系统提示词（general.prompt.ts）同步强化：工具结果是权威结论，成功（含 [ok] (no output)）即完成，不得为“验证”重复调用或换等价命令；已有足够信息时应直接回答。
