import 'reflect-metadata';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createTestApp, type TestAppHandle } from '../testing/test-app.js';

describe('conversations（会话业务抽象列表）', () => {
    let handle: TestAppHandle;
    let fastify: FastifyInstance;

    beforeAll(async () => {
        handle = await createTestApp({ copyDemoConfig: true });
        fastify = handle.fastify;
    });

    afterAll(async () => {
        await handle?.close();
    });

    it('POST /api/sessions 后生成一个含该 Session 的 Conversation，并携带用户/工作区归属', async () => {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: {
                input: '读取文件并汇报',
                userId: 'alice',
                workspace: '/workspace/project-a',
                projectId: 'project-a',
            },
        });
        expect(created.statusCode).toBe(200);
        const { sessionId } = created.json();

        const list = await fastify.inject({ method: 'GET', url: '/api/conversations' });
        expect(list.statusCode).toBe(200);
        const conversations = list.json() as Array<{
            conversationId: string;
            title: string;
            userId?: string;
            sessions: Array<{ sessionId: string }>;
            workspace?: string;
            projectId?: string;
        }>;
        const conversation = conversations.find((item) =>
            item.sessions.some((s) => s.sessionId === sessionId),
        );
        expect(conversation).toBeDefined();
        expect(conversation?.userId).toBe('alice');
        expect(conversation?.workspace).toBe('/workspace/project-a');
        expect(conversation?.projectId).toBe('project-a');
        expect(conversation?.sessions.map((s) => s.sessionId)).toEqual([sessionId]);
    });

    it('GET /api/conversations 回填历史 workspaces.json 中的存量 Session', async () => {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '历史任务' },
        });
        expect(created.statusCode).toBe(200);
        const { sessionId } = created.json();
        rmSync(join(handle.home, 'conversations.json'), { force: true });
        writeFileSync(
            join(handle.home, 'workspaces.json'),
            JSON.stringify({
                projects: [
                    {
                        title: 'legacy-project',
                        path: '/legacy/workspace',
                        sessionIds: [sessionId],
                    },
                ],
            }),
        );

        const list = await fastify.inject({ method: 'GET', url: '/api/conversations' });
        expect(list.statusCode).toBe(200);
        const conversations = list.json() as Array<{
            sessions: Array<{ sessionId: string }>;
            workspace?: string;
            projectId?: string;
        }>;
        const conversation = conversations.find((item) =>
            item.sessions.some((s) => s.sessionId === sessionId),
        );
        expect(conversation?.workspace).toBe('/legacy/workspace');
        expect(conversation?.projectId).toBe('/legacy/workspace');
    });
});
