import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('conversations（Goal run 会话业务抽象列表）', () => {
    let handle: TestAppHandle;
    let fastify: FastifyInstance;

    beforeAll(async () => {
        handle = await createTestApp({ copyDemoConfig: true });
        fastify = handle.fastify;
    });

    afterAll(async () => {
        await handle?.close();
    });

    it('POST /api/sessions 后生成一个含该 Goal run 的 Conversation，并携带用户/工作区归属', async () => {
        const workspacePath = join(handle.home, 'project-a');
        mkdirSync(workspacePath, { recursive: true });
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: {
                input: '读取文件并汇报',
                userId: 'alice',
                workspace: workspacePath,
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
            runs: Array<{ rootGoalId: string }>;
            workspace?: string;
            projectId?: string;
        }>;
        const conversation = conversations.find((item) =>
            item.runs.some((run) => run.rootGoalId === sessionId),
        );
        expect(conversation).toBeDefined();
        expect(conversation?.userId).toBe('alice');
        expect(conversation?.workspace).toBe(workspacePath);
        expect(conversation?.projectId).toBe('project-a');
        expect(conversation?.runs.map((run) => run.rootGoalId)).toEqual([sessionId]);
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
        expect(conversation.runs).toHaveLength(2);
    });

    it('GET /api/conversations 支持 q 筛选（标题/输入）与 limit 分页', async () => {
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
        ).json() as Array<{ title: string; runs: Array<{ input: string }> }>;
        expect(filtered.length).toBeGreaterThan(0);
        expect(
            filtered.every(
                (item) =>
                    item.title.includes(marker) || item.runs.some((r) => r.input.includes(marker)),
            ),
        ).toBe(true);

        const paged = (
            await fastify.inject({ method: 'GET', url: '/api/conversations?limit=1' })
        ).json() as unknown[];
        expect(paged.length).toBe(1);
    });

    it('PATCH /api/conversations/:id 重命名并归档，DELETE 后级联移除 Goal 树', async () => {
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '待管理会话' },
        });
        const { sessionId } = created.json();

        const before = (await fastify.inject({ method: 'GET', url: '/api/conversations' })).json();
        const conversation = before.find((item: { runs: Array<{ rootGoalId: string }> }) =>
            item.runs.some((run) => run.rootGoalId === sessionId),
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
                projects: [{ title: 'old-name', path: '/ws/project' }],
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
    it('DELETE /api/workspaces/project 仅删配置；对话记录保留并解除归属', async () => {
        const workspacePath = join(handle.home, 'project-del');
        mkdirSync(workspacePath, { recursive: true });
        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: {
                input: '项目内任务',
                workspace: workspacePath,
                projectId: 'project-del',
            },
        });
        expect(created.statusCode).toBe(200);
        const sessionId = created.json().sessionId;

        const del = await fastify.inject({
            method: 'DELETE',
            url: '/api/workspaces/project',
            headers: { 'content-type': 'application/json' },
            payload: { path: workspacePath },
        });
        expect(del.statusCode).toBe(200);
        expect(del.json().projects.some((p) => p.path === workspacePath)).toBe(false);

        const body = await fastify.inject({ method: 'GET', url: '/api/conversations' });
        const list = body.json();
        const conversation = list.find((item) => {
            const runs = item.runs || [];
            return runs.some((run) => run.rootGoalId === sessionId);
        });
        expect(conversation).toBeDefined();
        expect(conversation.workspace).toBeUndefined();
        expect(conversation.projectId).toBeUndefined();
        const detail = await fastify.inject({
            method: 'GET',
            url: '/api/sessions/' + sessionId + '/timeline',
        });
        expect(detail.statusCode).toBe(200);
    });

    it('旧版 conversations.json（sessionIds 结构）不拖垮列表，且可正常新建会话', async () => {
        writeFileSync(
            join(handle.home, 'conversations.json'),
            JSON.stringify({
                conversations: [
                    {
                        conversationId: 'legacy-1',
                        title: '旧版会话',
                        userId: 'old',
                        sessionIds: ['old-session-1'],
                        workspace: undefined,
                        projectId: undefined,
                        createdAt: 1000,
                        updatedAt: 2000,
                    },
                ],
            }),
        );
        const list = await fastify.inject({ method: 'GET', url: '/api/conversations' });
        expect(list.statusCode).toBe(200);
        const before = list.json();
        const legacy = before.find((item) => item.conversationId === 'legacy-1');
        expect(legacy).toBeDefined();
        expect(legacy.runs).toEqual([]);
        expect(legacy.title).toBe('旧版会话');

        const created = await fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '新任务' },
        });
        expect(created.statusCode).toBe(200);
        expect(typeof created.json().sessionId).toBe('string');

        const after = await fastify.inject({ method: 'GET', url: '/api/conversations' });
        expect(after.statusCode).toBe(200);
        expect(after.json().length).toBeGreaterThan(0);
    });
});
