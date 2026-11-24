# 执行 Loop：default 与 dynamic

运行时两条可切换的 Goal 执行路径。选择入口 `RunOptions.loopMode`，缺省 `default`。

## 一、两条路径

| | default | dynamic |
| --- | --- | --- |
| 实现 | `strategy/goal-strategy.ts` 的串行 cursor | `strategy/dynamic-loop.ts` + `WorkflowRunner` |
| 任务选择 | 拓扑序 while 循环 | Think 节点按「拓扑序 + 依赖已完成」选下一个 |
| 结果收敛 | 循环内直接处理 | Act → Observe（确定性收敛） |
| 完成判定 | 循环结束 + 验收汇总 | runner：开放任务清零 + 无 pending + 验收 |
| 失败处理 | 循环内 replan（若注入） | Reflect（失败≥2）→ 重新规划；v1 未接 replan |
| 元信息 | 无 | `result.loop = {mode, outcome, nodes}` |

`dynamic` 的节点链固定为：

```
Think（选任务）→ Act（executeTask + 验收）→ Observe（pending→facts）→ Think …
```

没有任何任务可执行（依赖失败）时，Think 把剩余 open 标记 failed，runner 以
`done-unverified` 收尾，runtime 结果 `ok=false`（验收没过）。但在实验指标层，**已有最终答案**的
`done-unverified` / `aborted-no-candidates` 记为执行 `succeeded`，验收单独记
`verification=unverified`（没有验收结论）或 `verification=failed`（验收明确未通过），
不按运行失败处理——否则有产出的臂会在 A/B 对比里被状态直接判负。

## 二、转移语义

相位是「本步要执行的节点角色」，不是「刚执行完的角色」。两道校验：

1. 进入：`assertTransition(lastPhase, node.role)`（首步跳过，固定 Think）；
2. 输出：`assertTransition(node.role, result.next)`。

`Think→Think`、`Act→Act` 依旧被表拦死；`Think→Plan→Think` 由 `Plan.requires` 的进展条件拦。

## 三、v1 边界（切换前必须补齐）

- **resume 不支持**：显式抛错，`TurnEngine` 在 `resume` 时回退 default。
- **跨 Task Replan 未接**：失败只做标记与 Reflect，不调用 `replanPlanner`。
- **跨 Goal memory 未召回**：`executeTask` 仍走 Task 内上下文，但没有 `MemoryManager` 召回/写回。

这三项在 A/B 里属于行为差异，读结果时要单独归因，不能当成「dynamic 更差」。

## 四、A/B 实验室

自变量闭集新增 `loopMode`：

```json
{
  "title": "loop 对照",
  "input": "同一任务",
  "variables": [{ "kind": "loopMode", "baseline": "default", "treatment": "dynamic" }],
  "baseline": { "loopMode": "default" },
  "arms": [{ "label": "A" }, { "label": "B", "loopMode": "dynamic" }]
}
```

两臂的 `RunOptions` 由 `resolveArm()` 注入 `loopMode`；指标新增：

- `loopMode`：本次实际使用的 loop；
- `termination`：`done / done-unverified / aborted-budget / aborted-no-progress / aborted-no-candidates / failed`；
- `nodeCount`：dynamic 实际执行的节点数；
- `loopNodes`：dynamic 的真实节点轨迹（`selected / failed / terminated` + role + nodeId + reason + at）。
- 展示口径：主会话不再单独渲染 workflow 节点框。节点语义落到 `Step.role`，按
  `think / plan / act / observe / verify / reflect` 展示为
  `Thinking / Planning / Acting / Observing / Verifying / Reflecting`；没有 role 的 default
  loop 按 kind 回退为 Thinking / Acting。`Step.kind` 仍是 deliberation / invocation，
  只负责 payload 与重放。
- Step 归属：`kind` 是技术判别式，`role` 是语义阶段，`nodeRunId / nodeId / agentRole` 是实际 node/agent
  归属；旧数据缺省，展示层按 kind 回退。
- Router 审计：SuperAgent 的 taskKind / risk / promptPack / planner / verifier / loopMode 落到
  `Goal.routing` 与 `superagent.decision`，Trace 契约区可见，不计入 workflow node。
- 收尾保护：真实工具动作失败后，如果模型只是重放此前已经成功的读取结果，不能把旧输出当作
  Task 最终答案；必须出现新的成功动作或模型给出最终回答。

比较时先看 `termination` 分布，再看 `step / toolCalls / tokens / costUsd / durationMs`；只看
`ok` 会把「验收缺失导致的 done-unverified」误判成成功。

## 五、灰度

`loopMode` 是产品开关，默认 `default`；不做全局默认切换，直到上面三项边界补齐并有对照数据。
切换动作只有一处：`TurnEngine` 里 `loopMode === 'dynamic' && !resume ? runGoalTreeDynamic : runGoalTree`。
