import { describe, expect, it } from 'vitest';
import { defaultConversations, isWorkspaceConversation, projectConversations } from './sidebar.ts';

function conversation(id, overrides = {}) {
    return {
        conversationId: id,
        title: `会话 ${id}`,
        sessions: [{ sessionId: `s-${id}` }],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe('sidebar conversation grouping', () => {
    it('workspace 与 projectId 必须成对才算工作区会话', () => {
        expect(isWorkspaceConversation(conversation('c1', { workspace: '/w' }))).toBe(false);
        expect(isWorkspaceConversation(conversation('c2', { projectId: 'p' }))).toBe(false);
        expect(
            isWorkspaceConversation(conversation('c3', { workspace: '/w', projectId: 'p' })),
        ).toBe(true);
    });

    it('默认会话区只保留未归属工作区的会话', () => {
        const conversations = [
            conversation('plain'),
            conversation('ws', { workspace: '/w', projectId: 'p' }),
        ];
        expect(defaultConversations(conversations).map((c) => c.conversationId)).toEqual(['plain']);
    });

    it('工作区分组从同一批 Conversation 中按归属筛选', () => {
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
