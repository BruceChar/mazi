# 会话与 Session 结构定义

> 版本：v0.2
> 目的：对齐「会话（Conversation）」「Session」「Turn / Step」的层级边界，并统一普通会话与工作区会话的数据结构。

## 1. 术语边界

| 术语 | 含义 |
| --- | --- |
| 会话（Conversation） | UI 侧一个可展开的对话条目，是一个聚合容器，**由多个 Session 组成**；普通会话与工作区会话是同一结构 |
| Session | 一次单独的用户输入，以及大模型针对该输入的**完整输出**；自身带 `sessionId`，原有 Session/Turn/Step 结构不变 |
| Turn / Step | 属于某个 Session 完整输出的执行轨迹，描述模型回复与工具调用过程；不跨 Session、更不跨会话 |
| 工作区会话 | 与普通会话完全同构，仅多了 `projectId`、`workspace` 两个归属属性 |

## 2. 结构定义

Conversation 属于 **API/应用层的业务抽象**，不在 `packages/core` 中定义；core 层仍只维护 Session/Turn/Step 领域契约。API 层 Conversation 通过组装核心 Session 形成可展示的业务会话。

```ts
// apps/api 层（示意；类型可引用 core 的 Session）
/** 会话：普通会话与工作区会话共用；一个会话由 Session[] 组成 */
interface Conversation {
    conversationId: string;
    title: string;
    /** 会话归属用户（可选）；Session 执行时从所属会话继承用于 Flag/画像 */
    userId?: string;
    sessions: Session[];
    /** 归属工作区项目时才有值：工作区标识/根路径 */
    workspace?: string;
    /** 归属工作区项目时才有值：工作区内项目标识 */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
}

// packages/core：Session/Turn/Step 领域契约保持独立
/** Session：一次单独的用户输入 + 大模型的完整输出（保留 Turn/Step 执行轨迹） */
interface Session {
    sessionId: string;
    rawIntent: string;
    turns: Turn[];
    // ...其余沿用现有 Session 字段（goal/state/aggregate/flagSnapshot/时间戳等），不含 userId
}
```

约束：

1. `Conversation.sessions` 是 `Session[]`；普通会话与工作区会话都是同一个 `Conversation` 容器，不再为工作区维护一套独立列表。
2. Session 仍是独立聚合，自身仅带 `sessionId`，不增加任何指向 Conversation 的反向字段；归属关系只由 `Conversation.sessions` 持有。
3. `userId` 表示会话归属用户，只挂在 Conversation 上；Session 不再保存 userId。Session 创建/Flag/用户画像需要用户上下文时，从所属 Conversation 读取。
4. 一个 Conversation 可以只包含一个 Session，也可以包含多个 Session；同一 Conversation 内的 Session 共享归属用户。
5. Turn / Step 只挂载在 core Session 下，是「一次用户输入 + 完整模型输出」内部的可观测轨迹；Conversation 不直接包含 Turn/Step。
6. 一个工作区项目会话仅当 `projectId` 与 `workspace` 同时存在时成立；二者必须成对出现。

## 3. UI 展示规则

侧边栏的两类列表是同一个 `Conversation[]` 的筛选视图，不再存储或返回第二份项目会话列表：

- 默认「会话」列表：`conversations.filter((c) => !c.projectId && !c.workspace)`；
- 工作区项目分组：按 `conversation.projectId / conversation.workspace` 分组后的同一批会话，项目内再按会话展示。

## 4. 对现有实现的影响

当前实现中 Session 直接承担了 UI「会话」的职责，且工作区归属由 `projects[].sessionIds` 外部维护。按本定义调整时涉及：

- core：Session 不再保存 `userId`；Session/Turn/Step 不感知 Conversation，不新增任何反向引用；
- apps/api：新增 Conversation 业务抽象并持有 `userId`/`workspace`/`projectId`/`sessions`；
- 存储：Conversation 通过 `sessions` 持有 Session 引用/列表，不再依赖 `workspaces.json` 的 `sessionIds` 作为唯一归属；用户维度数据（Flag/画像）在 API 层以 Conversation 的用户归属为入口；
- API：列表以 Conversation 为单位返回，工作区归属直接携带在会话对象上；
- WebUI：会话列表按 `Conversation.sessions` 渲染，工作区展示改为基于会话归属字段过滤。

以上影响在正式实施前以本文为准对齐，避免产生重复的数据视图。

## 5. 实现落地（v0.2）

- Conversation 由 apps/api 的 `ConversationsService` 以 JSON（`$MAZI_HOME/conversations.json`）持久化；Session 记录仍由 core 存储维护，Conversation 只持有 `sessionIds` 引用，不写回 Session。
- `POST /api/sessions` 每次创建 Session 时默认创建一个只含该 Session 的 Conversation；请求体的 `workspace` / `workspacePath` 会写入 Conversation 的工作区归属，`projectId` 缺省与该工作区相同。
- `GET /api/conversations` 返回 Conversation 投影：归属字段随 Conversation 返回，`sessions` 水合为 core Session 数组。
- 旧的 `workspaces.json` 项目会话关联保留为兼容层，后续 WebUI 迁移到 Conversation 过滤后移除。
- 向已有 Conversation 追加 Session 的入口（续聊）不在本期范围，`ConversationRecord.sessionIds` 已为追加预留。
