/**
 * 会话业务抽象（apps/api 层，不属于 core 领域契约）。
 * C5 迁移后：一次输入 = 一棵 Goal 树（run），Conversation 持有 run 引用（rootGoalId 数组），
 * 详情/时间线经 /api/sessions/:rootGoalId 的 Goal 树快照读取；本模块不再依赖 core Session。
 */

/** Conversation 内的单次 Goal 会话（= 一棵 Goal 树）引用 */
export interface GoalRunRef {
    rootGoalId: string;
    /** intake Goal 的 statement（原始输入） */
    input: string;
    createdAt: number;
}

export interface Conversation {
    conversationId: string;
    title: string;
    userId?: string;
    runs: GoalRunRef[];
    /** 工作区标识/根路径；与 projectId 成对出现 */
    workspace?: string;
    /** 工作区内项目标识；与 workspace 成对出现 */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
    /** 归档标记：true 表示从活动列表隐藏，可恢复 */
    archived?: boolean;
}

/** Conversation 持久化形态：仅持有 Goal run 引用（rootGoalId），展示时再取树快照 */
export interface ConversationRecord {
    conversationId: string;
    title: string;
    userId?: string;
    runs: GoalRunRef[];
    workspace?: string;
    projectId?: string;
    createdAt: number;
    updatedAt: number;
    archived?: boolean;
}

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
