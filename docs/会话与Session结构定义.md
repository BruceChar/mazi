# 会话与 Session 结构定义

> 版本：v0.1
> 目的：对齐「会话（Conversation）」「Session」「Turn / Step」的层级边界，并统一普通会话与工作区会话的数据结构。

## 1. 术语边界

| 术语 | 含义 |
| --- | --- |
| 会话（Conversation） | UI 侧一个可展开的对话条目，是一个聚合容器，**由多个 Session 组成**；普通会话与工作区会话是同一结构 |
| Session | 一次单独的用户输入，以及大模型针对该输入的**完整输出**；完整输出内部的执行轨迹由 Turn / Step 记录 |
| Turn / Step | 属于某个 Session 完整输出的执行轨迹，描述模型回复与工具调用过程；不跨 Session、更不跨会话 |
| 工作区会话 | 与普通会话完全同构，仅多了 `projectId`、`workspace` 两个归属属性 |

## 2. 结构定义

```ts
/** 会话：普通会话与工作区会话共用；一个会话由 Session[] 组成 */
interface Conversation {
    conversationId: string;
    title: string;
    sessions: Session[];
    /** 归属工作区项目时才有值：工作区标识/根路径 */
    workspace?: string;
    /** 归属工作区项目时才有值：工作区内项目标识 */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
}

/** Session：一次单独的用户输入 + 大模型的完整输出（保留 Turn/Step 执行轨迹） */
interface Session {
    sessionId: string;
    conversationId: string;
    userId?: string;
    rawIntent: string;
    turns: Turn[];
    // ...其余沿用现有 Session 字段（goal/state/aggregate/flagSnapshot/时间戳等）
}
```

约束：

1. `Conversation.sessions` 是 `Session[]`；普通会话与工作区会话都是同一个 `Conversation` 容器，不再为工作区维护一套独立列表。
2. `Session` 必须归属且仅归属一个会话，通过 `conversationId` 表达归属。
3. 一个工作区项目会话仅当 `projectId` 与 `workspace` 同时存在时成立；二者必须成对出现。
4. Turn / Step 只挂载在 Session 下，是「一次用户输入 + 完整模型输出」内部的可观测轨迹。

## 3. UI 展示规则

侧边栏的两类列表是同一个 `Conversation[]` 的筛选视图，不再存储或返回第二份项目会话列表：

- 默认「会话」列表：`conversations.filter((c) => !c.projectId && !c.workspace)`；
- 工作区项目分组：按 `conversation.projectId / conversation.workspace` 分组后的同一批会话，项目内再按会话展示。

## 4. 对现有实现的影响

当前实现中 Session 直接承担了 UI「会话」的职责，且工作区归属由 `projects[].sessionIds` 外部维护。按本定义调整时涉及：

- core 契约：新增 `Conversation`，Session 增加 `conversationId`；
- 存储：会话与 Session 的归属关系落到持久层，不再依赖 `workspaces.json` 的 `sessionIds`；
- API：列表以会话为单位返回，工作区归属直接携带在会话对象上；
- WebUI：会话列表按 `Conversation.sessions` 渲染，工作区展示改为基于会话归属字段过滤。

以上影响在正式实施前以本文为准对齐，避免产生重复的数据视图。
