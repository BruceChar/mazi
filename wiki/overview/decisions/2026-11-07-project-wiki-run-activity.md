# 项目 Wiki 自动记录会话活动

## 背景

项目 Wiki 的语义内容依赖 agent 主动写回。实际会话中，问候或状态查询可能只得到回答，
agent 没有执行 `claim` / overview 更新，导致用户连续聊天后 `state/current.md`
仍停留在初始化 TODO。

## 决策

- 有 Project 上下文的 Session 结束后，API 把同步任务投递到独立后台队列，不阻塞当前会话。
- 后台先调用 `wiki.py record` 追加请求、结果和摘要，再由隐藏 Agent 判断是否有
  durable 事实或文件变化需要更新 overview 与 claims。
- `record` 只维护 `state/current.md > 会话活动` 的最近 20 行，并自动提交 wiki/。
- overview、决策和 claims 仍由 agent 负责语义判断，自动记录不替代知识提炼。
- 前台只读 INDEX，并明确禁止主动询问用户是否初始化、更新或补全 Wiki。

## 结果

- 即使用户只是问候或重复询问状态，项目 Wiki 也会反映本次会话。
- 自动记录不会在测试套件中误写当前仓库。
