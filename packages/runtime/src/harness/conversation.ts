import type { LLMMessage, LLMProvider, PermissionLevel } from '@mazi/core';

/** 用户反馈载荷 */
export interface FeedbackInput {
    type: string;
    content?: string;
    rating?: number;
    timestamp: number;
}

/** Conversation 内此前轮次（共享上下文的最小形态：用户输入 + 助手最终回答） */
export interface ConversationTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface RunOptions {
    userId?: string;
    /** 本次 Goal 的权限档位（composer 选择）；缺省用配置默认。 */
    permissionCeiling?: PermissionLevel;
    /** 工作区根路径；文件工具只允许读取该目录内文件 */
    workspaceRoot?: string;
    /** providerId → LLMProvider 覆盖（离线测试注入；优先生效） */
    llmProviders?: Record<string, LLMProvider>;
    /** 同一 Conversation 内此前轮次，作为本轮前置消息（共享上下文） */
    history?: ConversationTurn[];
    /** 推理强度（off/low/medium/high...），透传 provider 的 reasoningEffort */
    reasoningLevel?: string;
    /** 指定模型 id（provider 内 model id；缺省用 provider 默认模型） */
    modelId?: string;
}

/** ConversationTurn[] → LLMMessage[]（user/assistant 文本消息）。 */
export function conversationMessages(turns: ConversationTurn[] | undefined): LLMMessage[] {
    if (turns === undefined || turns.length === 0) {
        return [];
    }
    return turns.map(
        (turn): LLMMessage =>
            turn.role === 'user'
                ? { role: 'user', content: [{ type: 'text', text: turn.text }] }
                : { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
    );
}
