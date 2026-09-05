import 'reflect-metadata';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestApp, type TestAppHandle } from './testing/test-app.js';

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

    it('follow=1：先回放 session.started，随后 live 收到 user.feedback.captured', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '读取 README.md 并汇报' },
        });
        const sessionId = created.json().sessionId;

        const stream = collectSse(port, `/api/events/${sessionId}?follow=1`, [
            'event: session.started',
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
        expect(result.text).toContain('event: session.started');
        expect(result.text).toContain('event: user.feedback.captured');
    });
});
