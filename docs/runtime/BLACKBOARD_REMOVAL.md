# 项目黑板移除（2026-11-24）

## 结论

项目知识层收敛为 **project wiki** 唯一入口，`blackboard` 相关逻辑与代码已全部删除。

## 删除内容

- 运行时模块 `packages/runtime/src/blackboard/`（store / service / injector / types）。
- `HarnessResources` 的 blackboard LazySlot、`MemoryPlane.blackboard`、装配期 `memory.blackboard`。
- TurnEngine 的项目黑板注入、运行结束 `updateFromRun`、`superagent.decision` 的 `blackboardRequired`。
- ToolPlane 的 `blackboard.read` 工具与 `blackboardToolConfigs`。
- API `projects` 控制器（4 个 blackboard 端点）与 `GET/POST /api/wiki` 中的 blackboard 字段、`POST /api/wiki/reconcile`。
- `projectIdForWorkspace` 从 blackboard 模块迁到 `packages/runtime/src/workspace-project.ts`，只保留“工作区 → 稳定 projectId”的纯函数。

## 行为变化

- 新会话不再注入任何项目状态摘要；项目事实只能通过 project wiki / 当前源码 / Git / 测试获得。
- `freshContext=true` 时既不注入 project wiki，也没有 blackboard 可注入。
- 历史数据库中的 `project_blackboards` 表不自动删除；代码不再读写，保留旧表不构成运行时依赖。

## 验收口径同步

- 基线验收只有 `final-answer`；`no-failed-steps` 已从契约与评估器删除。
- 历史契约若仍带 `no-failed-steps`，评估器记 `unchecked`，不进入 `evaluated`，不影响最终答案结论。
