# 架构
TODO：模块划分、数据流、依赖关系。只写代码无法自述的全局认知。

## 模块
TODO

## 数据流
TODO

## 项目知识库

- v2 事实源是项目仓库内的 `wiki/`；旧版 `$MAZI_HOME/wiki` 快照只作兼容数据保留。
- `GET /api/wiki` 同时返回兼容字段和 `repository` 只读视图；后者包含 Markdown 文档、
  claims 状态、摘要计数与最近知识提交。
- WebUI 采用“文档导航 / Markdown 正文 / 状态与事实证据”三栏布局，窄屏改为纵向流。
- 从项目菜单进入 Wiki 时，WebUI 同时切换全局工作区，顶部栏显示当前 Wiki 项目路径。
- 项目 Session 结束后，API 将同步任务放入按 workspace 串行的后台队列；后台先追加
  `state/current.md > 会话活动`，再由隐藏 Agent 判断是否更新语义内容和 claims。
- 前台 SessionStart 只注入 wiki INDEX；系统提示明确禁止主动询问是否初始化、更新或补全 Wiki。
- Wiki 页的“初始化”和“更新”通过 `/api/wiki/init|update` 启动隐藏项目 Agent；
  `/api/wiki/operations/:id` 轮询后台状态、最近 60 条 trace 与心跳，完成后自动重新读取文档与 claims。
- 后台维护 Agent 只能使用只读工具和受限 `project_wiki`：`write_doc` 仅能替换
  `wiki/**/*.md`，script 模式仅能调用 wiki.py 的维护子命令；初始化/更新完成和失败都写入会话活动。
- update 以最近 wiki checkpoint、git diff 和 current status 反查 evidence，只核验受影响 claims，
  不完整重读项目。
- Wiki 页在 KPI 下方展示完整 `state/current.md`；有效/待核验 KPI 可打开事实与 evidence
  明细；右侧独立订阅后台 Goal SSE，显示 reasoning/text stream、工具参数与输出、审批操作。
