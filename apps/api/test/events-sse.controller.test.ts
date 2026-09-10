import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newHarnessEvent } from '@mazi/runtime';
import { ApiRuntimeService } from '../src/common/runtime.service.js';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

function collectSse(
    port: number,
    path: string,
    markers: string[],
    timeoutMs = 8000,
): Promise<{ text: string; matched: boolean }> {
    return new Promise((resolve) => {
        const req = get(
            { host: '127.0.0.1', port, path, headers: { accept: 'text/event-stream' } },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    text += chunk;
                    if (markers.every((m) => text.includes(m))) {
                        resolve({ text, matched: true });
                        req.destroy();
                    }
                });
                res.on('end', () => resolve({ text, matched: false }));
            },
        );
        req.on('error', () => resolve({ text: '', matched: false }));
        setTimeout(() => {
            resolve({ text: '', matched: false });
            req.destroy();
        }, timeoutMs);
    });
}

describe('events SSE follow（NG-4）', () => {
    let h: TestAppHandle;
    let port: number;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
        await h.app.listen(0, '127.0.0.1');
        port = (h.app.getHttpServer().address() as AddressInfo).port;
    });

    afterAll(async () => {
        await h.close();
    });

    it('follow=1：先回放 goal.started，随后 live 收到 user.feedback.captured', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        const sessionId = created.json().sessionId;

        const stream = collectSse(port, `/api/events/${sessionId}?follow=1`, [
            'event: goal.started',
            'event: user.feedback.captured',
        ]);
        await new Promise((r) => setTimeout(r, 300)); // 让回放帧先写
        const fb = await h.fastify.inject({
            method: 'POST',
            url: `/api/sessions/${sessionId}/feedback`,
            headers: { 'content-type': 'application/json' },
            payload: { type: 'output_rating', rating: 5, content: '不错' },
        });
        expect(fb.statusCode).toBe(200);
        const result = await stream;
        expect(result.matched).toBe(true);
        expect(result.text).toContain('event: goal.started');
        expect(result.text).toContain('event: user.feedback.captured');
    });

    it('follow=1：llm.stream_event（token 级流式增量）实时转发', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '打个招呼' },
        });
        const sessionId = created.json().sessionId;

        const stream = collectSse(port, '/api/events/' + sessionId + '?follow=1', [
            'event: llm.stream_event',
        ]);
        await new Promise((r) => setTimeout(r, 300)); // 让回放帧先写
        h.app.get(ApiRuntimeService)
            .harness()
            .eventBus.emit(
                newHarnessEvent({
                    type: 'llm.stream_event',
                    rootGoalId: sessionId,
                    goalId: 'g-stream',
                    taskId: 't-stream',
                    payload: {
                        streamId: 's-stream',
                        attempt: 1,
                        event: { type: 'text_delta', text: '你' },
                    },
                }),
            );
        const result = await stream;
        expect(result.matched).toBe(true);
        expect(result.text).toContain('event: llm.stream_event');
        expect(result.text).toContain('text_delta');
    });

    it('事件回放（follow!=1）过滤 llm.stream_event 传输态增量', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '回放过滤' },
        });
        const sessionId = created.json().sessionId;
        h.app.get(ApiRuntimeService)
            .harness()
            .eventBus.emit(
                newHarnessEvent({
                    type: 'llm.stream_event',
                    rootGoalId: sessionId,
                    goalId: 'g-replay',
                    taskId: 't-replay',
                    payload: {
                        streamId: 's-replay',
                        attempt: 1,
                        event: { type: 'text_delta', text: 'x' },
                    },
                }),
            );
        const replay = await h.fastify.inject({ method: 'GET', url: `/api/events/${sessionId}` });
        expect(replay.statusCode).toBe(200);
        const types = replay.json().map((event: { type: string }) => event.type);
        expect(types).toContain('goal.started');
        expect(types).not.toContain('llm.stream_event');
    });
});
