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
