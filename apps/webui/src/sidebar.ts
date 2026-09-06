/** 会话归属字段是否完整，决定是否展示在工作区项目分组 */
export function isWorkspaceConversation(conversation) {
    return conversation?.workspace !== undefined && conversation?.projectId !== undefined;
}

/** 活动会话：排除已归档 */
export function activeConversations(conversations) {
    return (conversations || []).filter((conversation) => !conversation.archived);
}

/** 默认“会话”区：未归属任何工作区项目的会话 */
export function defaultConversations(conversations) {
    return (conversations || []).filter((conversation) => !isWorkspaceConversation(conversation));
}

/** 工作区项目分组：从同一批会话中按归属字段筛选 */
export function projectConversations(conversations, workspace, projectId) {
    return (conversations || []).filter(
        (conversation) =>
            conversation?.workspace === workspace && conversation?.projectId === projectId,
    );
}
