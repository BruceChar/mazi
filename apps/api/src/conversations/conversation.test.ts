import type { Session } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    type Conversation,
    defaultConversations,
    hasWorkspaceContext,
    projectConversations,
} from './conversation.js';

function session(id: string): Session {
    return {
        sessionId: id,
        rawIntent: `输入 ${id}`,
        strategyId: 'full-loop',
        state: 'running',
        turns: [],
        flagSnapshot: {
            values: {},
            trace: [],
            isEnabled: () => false,
            getNumber: () => undefined,
            getString: () => undefined,
        },
        createdAt: 0,
    } as Session;
}

function conversation(conversationId: string, overrides: Partial<Conversation> = {}): Conversation {
    return {
        conversationId,
        title: `会话 ${conversationId}`,
        sessions: [session('s1')],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe('Conversation API 抽象', () => {
    it('workspace 与 projectId 必须成对才算工作区会话', () => {
        expect(hasWorkspaceContext(conversation('c1', { workspace: '/w' }))).toBe(false);
        expect(hasWorkspaceContext(conversation('c2', { projectId: 'p' }))).toBe(false);
        expect(hasWorkspaceContext(conversation('c3', { workspace: '/w', projectId: 'p' }))).toBe(
            true,
        );
    });

    it('默认会话区只保留未归属工作区的会话', () => {
        const conversations = [
            conversation('plain'),
            conversation('ws', { workspace: '/w', projectId: 'p' }),
        ];
        expect(defaultConversations(conversations).map((c) => c.conversationId)).toEqual(['plain']);
    });

    it('工作区分组从同一 Conversation[] 中按归属字段筛选', () => {
        const conversations = [
            conversation('p1', { workspace: '/w', projectId: 'p1' }),
            conversation('p2', { workspace: '/w', projectId: 'p2' }),
            conversation('plain'),
        ];
        expect(
            projectConversations(conversations, '/w', 'p1').map((c) => c.conversationId),
        ).toEqual(['p1']);
    });
});
