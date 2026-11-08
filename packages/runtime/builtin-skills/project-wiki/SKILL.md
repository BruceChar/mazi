---
name: project-wiki
description: Project Wiki 的读取与事实治理说明。需要查询项目事实、修正旧结论、
  遗忘失效信息或写入项目知识时使用。
---
# Project Wiki

Project Wiki 是 Mazi runtime 内置的项目上下文能力。Runtime 负责初始化、上下文注入、
SessionEnd 沉淀、事实 oid 校验、纠错、遗忘和 checkpoint。

Wiki 数据位于项目仓库：

```text
wiki/
├── INDEX.md
├── overview/
├── state/
└── claims.toml
```

## 读取原则

1. 开始项目任务前先读 `wiki/INDEX.md`。
2. 需要细节时按索引读取相关文档，不整库通读。
3. 有争议时按 claim id 查询 `wiki/claims.toml` 和相关 evidence。
4. `retracted` claim 不再作为事实使用，只保留历史与审计价值。

## 写入事实

使用 runtime 提供的 `project_wiki` 工具：

- `claim_add`：新增事实，必须提供仓库内 evidence。
- `claim_update`：更新事实措辞或 evidence。
- `claim_verify`：语义仍成立时刷新 evidence oid。
- `claim_correct`：事实被修正时创建新 claim，并自动遗忘旧 claim。
- `claim_forget`：用户要求忘记、事实失效或不再适用时撤回事实。
- `write_doc`：写入 `wiki/` 下的 Markdown。
- `checkpoint`：校验并提交 Wiki。

Evidence oid 由 runtime 计算，不要手写。

## 修正与遗忘

事实发生语义变化时不要直接覆盖旧结论：

```text
claim_correct(
  id = 旧 claim id,
  newId = 新 claim id,
  text = 新事实,
  evidence = [真实来源],
  reason = 为什么旧事实失效
)
```

旧 claim 会标记为 `retracted/corrected` 并指向 `superseded_by`；新 claim 使用
`supersedes` 指回旧事实。后续 Context Packet 只使用新事实。

用户明确要求忘记某项事实时使用 `claim_forget` 并填写 reason。物理审计历史仍保留在 Git，
但被遗忘事实不会进入后续上下文。

## 红线

- 不写入无法由 evidence 支持的推测。
- 不把用户隐私、日志正文或密钥写入 Project Wiki。
- 不手改 `claims.toml`。
- 不提交用户源码；runtime 只提交 `wiki/`。
- 不把陈旧事实继续注入上下文；必须 verify、correct 或 forget。
