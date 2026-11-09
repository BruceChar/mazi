# 当前状态

## 现在
- 阶段：streaming UI 展开修复 + 验收失败语义/默认 replan 修复完成（0467b19 / 55a2346 / 4caea3e）
- 进行中：等待重启 6294 的 API 后做真实会话验收（runtime 改动需重启进程；dist 已重建）

## 阻塞与风险
- 阻塞：无
- 风险：工作区仍有另一会话的 project-wiki WIP 未提交（runtime.ts / apps/api / webui wiki 相关），本次提交只包含本会话改动，未触碰它们
- 风险：默认 replan 会额外调用一次 LLM（仅失败时、有次数上限）；P1 语义 judge 仍未接，语义条款保持 unchecked

## 下一步
- 重启 API 后跑一次多步骤项目任务：确认多 Task 计划、失败后能 replan 继续、验收失败不再 goal success
- 观察 streaming 中 live 步骤的展开/折叠体验（仅活动推理单行）

## 最近变化
- live 执行列表每步可展开/折叠（默认展开），settled 树恢复默认展开；只折叠正在流式输出的推理
- 验收 failed 时 Task/Goal/goal.ended 均记失败（aborted 保持可恢复）；失败分类账记录验收失败
- 默认 LLM Replan：失败后补剩余 Task 继续执行（maxReplans 上限）；Task Planner 对多产物单 Task 计划用 strictSplit 重试
- shell.run SIGPIPE(141) 视为成功，避免 git log|head 之类的误报失败

## 会话活动
<!-- activity:start -->
- 2026-11-08 00:00:56 | 成功 | 重构项目 Wiki 的 SessionEnd 与增量更新工作流 | 确定性 session-end、按需语义更新、批量 oid 核验和 Python 3.9 兼容已实现，全量 1083 项测试通过
- 2026-11-08 13:55:43 | 成功 | 修复只读探索会话不沉淀 Wiki 的问题 | SessionEnd 现在从 Goal trace 提取安全读取文件，即使无 git diff 也会异步沉淀部署、架构与流程事实；全量 1084 项测试通过
- 2026-11-08 14:00:24 | 成功 | 修复 BOSS 项目探索会话不沉淀 Wiki | 从 Session trace 提取安全读取文件并在无 diff 时自动沉淀；BOSS Wiki 已补齐 6 份文档、8 条 claims，checkpoint 成功；全量 1085 项测试通过
- 2026-11-08 14:48:29 | 成功 | 设计 runtime 内置 Project Context Lifecycle | 定义项目上下文生命周期、Context Packet、长会话压缩锚点、SessionEnd 自动沉淀、持久队列、安全边界、API/UI 与迁移路径
- 2026-11-08 15:18:27 | 成功 | 迁移 Project Wiki 到 runtime 并实现事实纠正与遗忘 | wiki.py 核心能力迁入 runtime/wiki；Harness/API 不再依赖 Python；新增 runtime CLI、claim correct/forget、API 与 UI 状态；全量 1088 项测试通过
- 2026-11-08 20:30:33 | 失败 | 项目有代办吗 | 有，但不多。扫描命令均正常退出（`exit=0`）。 ## 1. 唯一的待办清单文件：`docs/TODO.md` \| 行 \| 主题 \| 内容 \| \|---\|---\|---\| \| 2-5 \| 用户行为追踪 \| 思维链、授权等行为链 \| \| 7-25 \| Provider 监控面板 \| 模型性能/延迟/能力/收费/满意度展示，默认
- 2026-11-08 20:32:15 | 成功 | 更新项目 Wiki | ``` wiki(checkpoint): ok docs_changed: - INDEX.md : 一句话/技术栈/红线/模块地图（6 模块职责）补全 - overview/architecture.md : 分层依赖、模块职责、执行坐标系、设计不变量、数据流、Roadmap 入口（保留原有 Project Wiki 段） - overview/conv
- 2026-11-08 21:14:43 | 成功 | wiki v2有没代办 | 有 3 项，全部集中在产品层；wiki v2 的核心功能已全部完成。 ## 1. 唯一的 wiki 待办清单（`docs/TODO.md:33`「项目 Wiki（后续）」） \| # \| 待办 \| 当前代码事实 \| 状态 \| \|---\|---\|---\|---\| \| 1 \| 接入模型摘要 provider \| `createLlmSum
- 2026-11-08 21:16:23 | 失败 | 更新项目 Wiki | 项目 Wiki 维护失败
- 2026-11-08 21:21:06 | 失败 | 更新项目 Wiki | import { resolve } from 'node:path'; /** 归一化工作区（项目）路径，用于持久化与比较： - 去掉结尾斜杠（/a/b/ → /a/b），解析 . / ..（node:path resolve）； - 纯字符串运算：不访问文件系统、不解析 symlink、macOS 大小写保持原样…
- 2026-11-09 01:20:19 | 成功 | 再检查一次项目代办 | 只读复检完成，`git status` 仅 `.tmp-api-home/settings.json`（自动时间戳），HEAD 仍是 `7ea1ea6`。**本轮结论与上一轮逐项一致，无新增待办，无新增技术债。** ## 与上轮的逐项比对 \| 项 \| 结果 \| \|---\|---\| \| 源码标记 \| **61 次 `TODO`，FIXME/XX
- 2026-11-09 01:21:44 | 失败 | 更新项目 Wiki | 项目 Wiki 维护失败
- 2026-11-09 18:23:50 | 成功 | 更新项目 Wiki | /** Agent 系统提示注册表：内置默认 + 配置覆盖的唯一事实源。 * 配置来自 settings.json prompts 段（RuntimeConfig.agentPrompts），优先级固定为 配置 > 内置默认；空白值视为未配置，回落到默认。 */ import { GENERAL_PROMPT } f…
<!-- activity:end -->
