# 项目 Wiki 初始化与更新按钮

## 背景

旧页面的“校验知识”和“刷新”只触发只读对账或重新请求，投影没有可见变化。
用户需要从 Wiki 页面直接创建完整知识库，并在项目变化后核对 claims 与 oid。

## 决策

- “初始化”调用 Agent 读取 README、AGENTS、工作区清单和关键入口，完成冷启动、
  首批 claims、doctor 与 checkpoint。
- “更新”调用 Agent 执行 `wiki.py update --plan`，逐条 verify/update/retract，
  刷新 evidence oid，再更新相关文档并 checkpoint。
- Agent 任务使用隐藏项目 Goal，不创建侧边栏会话；权限固定为 `workspace-write`。
- 后台 operation 只保存在 API 进程内，WebUI 轮询状态并展示摘要或错误。
- 后台 Goal 的 trace 事件、最后心跳和运行时长随 operation 返回；右侧任务卡可直接
  判断仍在运行、等待模型/审批或疑似停滞。
- WebUI 还独立订阅后台 Goal 的 SSE，复用主会话实时投影显示 reasoning/text
  stream、工具参数与结果；审批卡内直接调用 `/api/approvals/:id` 完成人审。
- 后台工具面只保留只读工具和受限 `project_wiki`；后者既调用 wiki.py 也允许
  `mode=write_doc` 替换 `wiki/**/*.md`。不暴露 shell.run，避免 `rm` / `git checkout`，
  wiki/ 外写入也被拒绝；真正出现审批时 Trace 显示等待审批。
- 完整当前状态卡片放在 KPI 下方；有效事实与待核验可打开 claim/evidence 明细。

## 结果

- 两个按钮都产生可观察的 Agent 行为，不再依赖用户另开会话。
- 初始化负责建立知识库，更新负责维护已有事实的时效性。
