import type { Session } from '@mazi/core';

/**
 * 会话业务抽象（apps/api 层，不属于 core 领域契约）。
 * 普通会话与工作区会话共用同一结构；`sessions` 由 core Session 组装。
 */
export interface Conversation {
    conversationId: string;
    title: string;
    userId?: string;
    sessions: Session[];
    /** 工作区标识/根路径；与 projectId 成对出现 */
    workspace?: string;
    /** 工作区内项目标识；与 workspace 成对出现 */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
}

/** 归属字段是否完整，决定该会话是否属于工作区项目 */
export function hasWorkspaceContext(conversation: Conversation): boolean {
    return conversation.workspace !== undefined && conversation.projectId !== undefined;
}

/** 默认“会话”区：未归属任何工作区项目的会话 */
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
