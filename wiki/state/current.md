# 当前状态

## 现在
- 阶段：契约/规划可靠性 P0 修复 + P2 机械检查扩展完成（4 个 commit：9d3c324 / a414197 / 26febad / 2bc636d）
- 进行中：等待用户在重启 API 后做真实会话验收（runtime 改动需重启 6294 的 API 进程才生效）

## 阻塞与风险
- 阻塞：无
- 风险：P1（LLM 语义判定 SemanticJudge 接入）尚未实现，语义条款仍为 unchecked，不冒充通过；工作区仍有另一会话的 project-wiki WIP 未提交（runtime.ts 等），本次提交未包含它们
- 风险：`plan.created` 新增 tasks 字段；消费方需容忍旧事件缺该字段

## 下一步
- 重启 API（node apps/api/dist/main.js，dist 已重建）后用真实项目会话验收：多 Task 计划、机械条款判定、失败触发 replan
- 视需要实现 P1 语义判定（建议按 Task 批量调用 judge）

## 最近变化
- Task Planner 规划前等待 triage、注入同 Conversation 历史、prompt 强化多 Task 拆分；plan.created 带 Task 标题/依赖
- shell.run 启用 pipefail；sd 等写工具无改动返回失败；失败信号可触发 replan
- 契约新增机械检查词表：file-exists / file-contains / git-has-commit / command-output-contains；triage 可输出结构化 check；verifier 注入 ConditionEnvironment 端到端判定
- 文档：docs/core/AHF_CORE_GTS.md §4.1、新增 docs/runtime/AHF_RUNTIME_TASK_PLANNING.md

## 项目 Wiki UI
- 当前状态改为 KPI 下方完整卡片，不再截断为前 5 条。
- 有效事实/待核验可打开 claim 与 evidence 明细；最近更新时间精确到秒。
- 后台初始化、更新和 SessionEnd 同步显示 trace、心跳、运行时长与停滞提示。
- 后台维护只暴露只读工具和受限 `project_wiki`；不再使用 shell.run，因此不会因 rm/git checkout 卡审批。
- `project_wiki.write_doc` 可维护 wiki/ Markdown；init/update 自身也写入活动记录。
- update 使用 checkpoint diff + git status + evidence 反查，只读取受影响文件。
