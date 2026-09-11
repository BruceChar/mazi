import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('workspaces API（随心聊默认工作区）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
    });

    afterAll(async () => {
        await h.close();
    });

    it('默认随心聊工作区 = $MAZI_HOME/workspace，且目录已创建', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/workspaces/current' });
        expect(res.statusCode).toBe(200);
        expect(res.json().freeChatPath).toBe(join(h.home, 'workspace'));
        expect(existsSync(join(h.home, 'workspace'))).toBe(true);
    });

    it('POST /api/workspaces/free-chat 保存并持久化；空路径回退默认', async () => {
        const target = join(h.home, 'chat-space');
        const res = await h.fastify.inject({
            method: 'POST',
            url: '/api/workspaces/free-chat',
            payload: { path: target },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().path).toBe(target);
        const current = await h.fastify.inject({ method: 'GET', url: '/api/workspaces/current' });
        expect(current.json().freeChatPath).toBe(target);

        const reset = await h.fastify.inject({
            method: 'POST',
            url: '/api/workspaces/free-chat',
            payload: { path: '' },
        });
        expect(reset.json().path).toBe(join(h.home, 'workspace'));
    });

    it('GET /api/config 暴露 freeChatWorkspace', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/config' });
        expect(res.json().freeChatWorkspace).toBe(join(h.home, 'workspace'));
    });
});
