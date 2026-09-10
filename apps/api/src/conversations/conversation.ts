import type { Conversation } from '@mazi/libs';

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
