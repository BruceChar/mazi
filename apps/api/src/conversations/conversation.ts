import type { Conversation, ConversationRecord } from '@mazi/libs';

// Re-export shared types for backward compatibility with existing imports.
export type { Conversation, ConversationRecord, GoalRunRef } from '@mazi/libs';

/**
 * 会话业务抽象（apps/api 层，不属于 core 领域契约）。
 * C5 迁移后：一次输入 = 一棵 Goal 树（run），Conversation 持有 run 引用（rootGoalId 数组），
 * 详情/时间线经 /api/sessions/:rootGoalId 的 Goal 树快照读取；本模块不再依赖 core Session。
 *
 * 类型定义（Conversation / ConversationRecord / GoalRunRef）已上移到 @mazi/libs，
 * 供 apps/api 与 apps/webui 共享；本文件仅保留 api 层的转换与过滤函数。
 */

/** 持久化记录 → API 会话对象（run 引用即返回，水合交由 /api/sessions/:rootGoalId） */
export function conversationFromRecord(record: ConversationRecord): Conversation {
    return {
        conversationId: record.conversationId,
        title: record.title,
        userId: record.userId,
        runs: record.runs.map((run) => ({ ...run })),
        workspace: record.workspace,
        projectId: record.projectId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        archived: record.archived,
    };
}

/** 归属字段是否完整，决定该会话是否属于工作区项目 */
export function hasWorkspaceContext(conversation: Conversation): boolean {
    return conversation.workspace !== undefined && conversation.projectId !== undefined;
}

/** 默认"会话"区：未归属任何工作区项目的会话 */
export function defaultConversations(conversations: Conversation[]): Conversation[] {
    return conversations.filter((conversation) => !hasWorkspaceContext(conversation));
}

/** 工作区项目分组：同一项目下的会话 */
export function projectConversations(
    conversations: Conversation[],
    workspace: string,
    projectId: string,
): Conversation[] {
    return conversations.filter(
        (conversation) =>
            conversation.workspace === workspace && conversation.projectId === projectId,
    );
}
