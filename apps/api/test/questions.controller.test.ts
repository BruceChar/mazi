import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

describe('questions（问题查询/标签/重标/分类法）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
    });

    afterAll(async () => {
        await h.close();
    });

    it('问题入库 + 轴过滤 + 用户标签覆盖 + 分类法 + 重标', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            headers: { 'content-type': 'application/json' },
            payload: { input: '这个设计有什么根本问题？', userId: 'qme' },
        });
        expect(created.statusCode).toBe(200);

        const list = await h.fastify.inject({ method: 'GET', url: '/api/users/qme/questions' });
        expect(list.statusCode).toBe(200);
        const questions = (list.json() as { questions: Array<Record<string, unknown>> }).questions;
        expect(questions).toHaveLength(1);
        const question = questions[0] as {
            questionId: string;
            text: string;
            effective: { speech_act?: string[] };
        };
        expect(question.text).toBe('这个设计有什么根本问题？');
        expect(question.effective.speech_act).toEqual(['question']);

        const tasks = await h.fastify.inject({
            method: 'GET',
            url: '/api/users/qme/questions?type=task',
        });
        expect((tasks.json() as { questions: unknown[] }).questions).toEqual([]);
        const asked = await h.fastify.inject({
            method: 'GET',
            url: '/api/users/qme/questions?type=question',
        });
        expect((asked.json() as { questions: unknown[] }).questions).toHaveLength(1);

        const detail = await h.fastify.inject({
            method: 'GET',
            url: '/api/questions/' + question.questionId,
        });
        expect(detail.statusCode).toBe(200);

        const labelled = await h.fastify.inject({
            method: 'POST',
            url: '/api/questions/' + question.questionId + '/labels',
            headers: { 'content-type': 'application/json' },
            payload: { labels: [{ axis: 'domain', label: 'professional' }] },
        });
        expect(labelled.statusCode).toBe(200);
        expect((labelled.json() as { effective: { domain?: string[] } }).effective.domain).toEqual([
            'professional',
        ]);

        const bad = await h.fastify.inject({
            method: 'POST',
            url: '/api/questions/' + question.questionId + '/labels',
            headers: { 'content-type': 'application/json' },
            payload: { labels: [{ axis: 'domain', label: 'bogus' }] },
        });
        expect(bad.statusCode).toBe(400);

        const taxonomy = await h.fastify.inject({ method: 'GET', url: '/api/question-taxonomy' });
        expect((taxonomy.json() as { speechAct: string[] }).speechAct).toContain('question');

        const reclassified = await h.fastify.inject({
            method: 'POST',
            url: '/api/questions/' + question.questionId + '/classify',
        });
        expect(reclassified.statusCode).toBe(200);

        const missing = await h.fastify.inject({ method: 'GET', url: '/api/questions/nope' });
        expect(missing.statusCode).toBe(404);
    });
});
