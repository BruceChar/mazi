import type { Conversation } from '../types';

/** True when both workspace and projectId are present (workspace project group). */
export function isWorkspaceConversation(conversation: Conversation | null | undefined): boolean {
    return conversation?.workspace !== undefined && conversation?.projectId !== undefined;
}

/** Active conversations: archived entries are excluded. */
export function activeConversations(
    conversations: Conversation[] | null | undefined,
): Conversation[] {
    return (conversations || []).filter((conversation) => !conversation.archived);
}

/** Default "chats" group: conversations not attached to a workspace project. */
export function defaultConversations(
    conversations: Conversation[] | null | undefined,
): Conversation[] {
    return (conversations || []).filter((conversation) => !isWorkspaceConversation(conversation));
}

/** Conversations belonging to a given workspace project. */
export function projectConversations(
    conversations: Conversation[] | null | undefined,
    workspace: string,
    projectId: string,
): Conversation[] {
    return (conversations || []).filter(
        (conversation) =>
            conversation?.workspace === workspace && conversation?.projectId === projectId,
    );
}
