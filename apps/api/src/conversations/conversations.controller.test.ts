import 'reflect-metadata';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        const stored = JSON.parse(readFileSync(join(handle.home, 'workspaces.json'), 'utf8')) as {
            projects: Array<{ sessionIds?: string[] }>;
        };
        expect(stored.projects[0].sessionIds).toBeUndefined();
    });

    it('POST /api/sessions 携带 conversationId 时追加到已有 Conversation', async () => {
        const first = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '第一问' },
        });
        expect(first.statusCode).toBe(200);
        const firstBody = first.json() as { conversationId: string };

        const second = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '追问', conversationId: firstBody.conversationId },
        });
        expect(second.statusCode).toBe(200);
        expect((second.json() as { conversationId: string }).conversationId).toBe(
            firstBody.conversationId,
        );

        const list = (await fastify.inject({ method: 'GET', url: '/api/conversations' })).json();
        const conversation = list.find(
            (item: { conversationId: string }) => item.conversationId === firstBody.conversationId,
        );
        expect(conversation.sessions).toHaveLength(2);
    });

    it('GET /api/conversations 支持 q 筛选与 limit 分页', async () => {
        const marker = `分页标记 ${Date.now()}`;
        await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: marker },
        });

        const filtered = (
            await fastify.inject({
                method: 'GET',
                url: `/api/conversations?q=${encodeURIComponent(marker)}`,
            })
        ).json() as Array<{ title: string }>;
        expect(filtered.length).toBeGreaterThan(0);
        expect(filtered.every((item) => item.title.includes(marker))).toBe(true);

        const paged = (
            await fastify.inject({ method: 'GET', url: '/api/conversations?limit=1' })
        ).json() as unknown[];
        expect(paged.length).toBe(1);
    });

    it('PATCH /api/conversations/:id 重命名并归档，DELETE 后级联移除 Session', async () => {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '待管理会话' },
        });
        const { sessionId } = created.json();

        const before = (await fastify.inject({ method: 'GET', url: '/api/conversations' })).json();
        const conversation = before.find((item: { sessions: Array<{ sessionId: string }> }) =>
            item.sessions.some((s) => s.sessionId === sessionId),
        );
        expect(conversation).toBeDefined();

        const patched = await fastify.inject({
            method: 'PATCH',
            url: `/api/conversations/${conversation.conversationId}`,
            headers: { 'content-type': 'application/json' },
            payload: { title: '改名后的会话', archived: true },
        });
        expect(patched.statusCode).toBe(200);

        const after = (await fastify.inject({ method: 'GET', url: '/api/conversations' })).json();
        const renamed = after.find(
            (item: { conversationId: string }) =>
                item.conversationId === conversation.conversationId,
        );
        expect(renamed.title).toBe('改名后的会话');
        expect(renamed.archived).toBe(true);

        const removed = await fastify.inject({
            method: 'DELETE',
            url: `/api/conversations/${conversation.conversationId}`,
        });
        expect(removed.statusCode).toBe(200);
        const finalList = (
            await fastify.inject({ method: 'GET', url: '/api/conversations' })
        ).json();
        expect(
            finalList.some(
                (item: { conversationId: string }) =>
                    item.conversationId === conversation.conversationId,
            ),
        ).toBe(false);
        const sessionDetail = await fastify.inject({
            method: 'GET',
            url: `/api/sessions/${sessionId}/timeline`,
        });
        expect(sessionDetail.statusCode).toBe(404);
    });

    it('PATCH /api/workspaces/project 重命名项目展示名', async () => {
        writeFileSync(
            join(handle.home, 'workspaces.json'),
            JSON.stringify({
                projects: [{ title: 'old-name', path: '/ws/project', sessionIds: [] }],
            }),
        );
        const res = await fastify.inject({
            method: 'PATCH',
            url: '/api/workspaces/project',
            headers: { 'content-type': 'application/json' },
            payload: { path: '/ws/project', title: 'new-name' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().projects).toEqual([{ title: 'new-name', path: '/ws/project' }]);
    });
});
