/**
 * 对照实验接口（docs/AB测试设计.md §8.2、AB-11）。
 * POST /api/experiments 只建两臂会话；POST /api/experiments/:id/run 前台并行执行。
 * 测试环境无可用厂商 provider（faux 未注册）：两臂以 driver-error 结束，但事件/审批链路与真实一致。
 */

import 'reflect-metadata';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

const SPEC = {
    title: 'Feature 增益',
    hypothesis: '开启简洁作答可降低输出长度',
    input: '简单介绍一下 mazi',
    variables: [
        { kind: 'feature', label: 'concise', baseline: false, treatment: true },
    ],
    arms: [
        { label: 'A', features: { concise: false } },
        { label: 'B', features: { concise: true } },
    ],
};

describe('对照实验接口', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp({ copyDemoConfig: true });
        await h.fastify.inject({
            method: 'POST',
            url: '/api/features',
            payload: {
                id: 'concise',
                name: '简洁作答',
                description: '先给结论',
                promptFragment: '简洁作答：先给结论。',
            },
        });
    });

    afterAll(async () => {
        await h.close();
    });

    it('POST 非法 spec → 400（缺 input / 两臂不齐 / 自变量非法）', async () => {
        const noInput = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments',
            payload: { ...SPEC, input: '' },
        });
        expect(noInput.statusCode).toBe(400);

        const oneArm = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments',
            payload: { ...SPEC, arms: [{ label: 'A' }] },
        });
        expect(oneArm.statusCode).toBe(400);
        expect(oneArm.json().error).toContain('恰好两个');

        const badKind = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments',
            payload: { ...SPEC, variables: [{ kind: 'bucket' }] },
        });
        expect(badKind.statusCode).toBe(400);
    });

    it('POST 创建（不执行）：两臂 pending + rootGoalId，日志已落盘', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments',
            payload: SPEC,
        });
        expect(created.statusCode).toBe(200);
        const view = created.json();
        expect(view.status).toBe('created');
        expect(view.arms.map((arm: { status: string }) => arm.status)).toEqual([
            'pending',
            'pending',
        ]);
        expect(view.arms[0].rootGoalId).toBeTruthy();
        expect(view.arms[0].rootGoalId).not.toBe(view.arms[1].rootGoalId);

        const logs = readdirSync(join(h.home, 'experiments')).filter((name) =>
            name.endsWith('.jsonl'),
        );
        expect(logs).toContain(view.experimentId + '.jsonl');
    });

    it('POST /:id/run 前台执行两臂 → completed + 对比；重复 run 幂等', async () => {
        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        const experimentId = list.json().experiments[0].experimentId;

        const run = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments/' + experimentId + '/run',
        });
        expect(run.statusCode).toBe(200);
        const done = run.json();
        expect(done.status).toBe('completed');
        // 无可用 provider → 两臂以 driver-error 结束；Feature 解析仍到达运行配置。
        expect(done.arms.map((arm: { status: string }) => arm.status)).toEqual([
            'failed',
            'failed',
        ]);
        expect(done.arms[1].metrics.features).toEqual({ concise: true });
        expect(done.comparison.execution).toBe('sequential');
        expect(done.comparison.metrics.some((m: { key: string }) => m.key === 'costUsd')).toBe(
            true,
        );

        const again = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments/' + experimentId + '/run',
        });
        expect(again.statusCode).toBe(200);
        expect(again.json().status).toBe('completed');
    });

    it('存储隔离：实验 Goal 树在 experiments/mazi.db，主会话看不到它；主会话自身照常工作', async () => {
        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        const experimentId = list.json().experiments[0].experimentId;
        const rootGoalId = list.json().experiments[0].arms[0].rootGoalId;

        // 实验独立存储：Goal 库与事件目录都在 $MAZI_HOME/experiments 下。
        expect(existsSync(join(h.home, 'experiments', 'mazi.db'))).toBe(true);
        expect(existsSync(join(h.home, 'experiments', 'events', rootGoalId + '.jsonl'))).toBe(true);

        // 主会话端点按 rootGoalId 查不到实验 run（Goal 树确实分开了）。
        const viaMainSession = await h.fastify.inject({
            method: 'GET',
            url: '/api/sessions/' + rootGoalId + '/timeline',
        });
        expect(viaMainSession.statusCode).toBe(404);

        // 实验专用端点能读到该臂的 Goal 树与事件流。
        const timeline = await h.fastify.inject({
            method: 'GET',
            url: '/api/experiments/' + experimentId + '/arms/A/timeline',
        });
        expect(timeline.statusCode).toBe(200);
        expect(timeline.json().rootGoalId).toBe(rootGoalId);
        expect(Array.isArray(timeline.json().goals)).toBe(true);

        const events = await h.fastify.inject({
            method: 'GET',
            url: '/api/experiments/' + experimentId + '/arms/A/events',
        });
        expect(events.statusCode).toBe(200);
        expect(Array.isArray(events.json())).toBe(true);

        // 主会话照常创建/执行（与实验各自独立，互不阻塞）。
        const session = await h.fastify.inject({
            method: 'POST',
            url: '/api/sessions',
            payload: { input: '读取 README.md 并汇报' },
        });
        const sessionId = session.json().sessionId;
        expect(session.statusCode).toBe(200);
        const mainTimeline = await h.fastify.inject({
            method: 'GET',
            url: '/api/sessions/' + sessionId + '/timeline',
        });
        expect(mainTimeline.statusCode).toBe(200);
        expect(mainTimeline.json().rootGoalId).toBe(sessionId);
    });

    it('GET 详情 → 折叠视图；未知 id → 404；非法 id → 404（不触盘）', async () => {
        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        const experimentId = list.json().experiments[0].experimentId;

        const detail = await h.fastify.inject({
            method: 'GET',
            url: '/api/experiments/' + experimentId,
        });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().title).toBe('Feature 增益');
        expect(detail.json().variables).toHaveLength(1);

        const ghost = await h.fastify.inject({
            method: 'GET',
            url: '/api/experiments/01ARZ3NDEKTSV4RRFFQ69G5FAV',
        });
        expect(ghost.statusCode).toBe(404);

        const traversal = await h.fastify.inject({
            method: 'GET',
            url: '/api/experiments/..%2F..%2Fetc%2Fpasswd',
        });
        expect(traversal.statusCode).toBe(404);
    });

    it('复盘 append-only；缺 note → 400', async () => {
        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        const experimentId = list.json().experiments[0].experimentId;

        const missing = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments/' + experimentId + '/reviews',
            payload: {},
        });
        expect(missing.statusCode).toBe(400);

        const reviewed = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments/' + experimentId + '/reviews',
            payload: { note: 'B 臂输出更短，采纳', verdict: 'B' },
        });
        expect(reviewed.statusCode).toBe(200);
        expect(reviewed.json().reviews).toEqual([
            { note: 'B 臂输出更短，采纳', verdict: 'B', at: expect.any(Number) },
        ]);
    });

    it('rerun 复制为新的待执行实验；DELETE 物理删除；未知 id 404', async () => {
        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        const experimentId = list.json().experiments[0].experimentId;

        const rerun = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments/' + experimentId + '/rerun',
        });
        expect(rerun.statusCode).toBe(200);
        expect(rerun.json().experimentId).not.toBe(experimentId);
        expect(rerun.json().status).toBe('created');
        expect(rerun.json().arms.map((arm: { status: string }) => arm.status)).toEqual([
            'pending',
            'pending',
        ]);

        const afterList = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        expect(afterList.json().experiments.length).toBe(2);

        const removed = await h.fastify.inject({
            method: 'DELETE',
            url: '/api/experiments/' + experimentId,
        });
        expect(removed.json()).toEqual({ ok: true, removed: true });
        const gone = await h.fastify.inject({
            method: 'GET',
            url: '/api/experiments/' + experimentId,
        });
        expect(gone.statusCode).toBe(404);

        const unknown = await h.fastify.inject({
            method: 'DELETE',
            url: '/api/experiments/01ARZ3NDEKTSV4RRFFQ69G5FAV',
        });
        expect(unknown.statusCode).toBe(404);
    });
});
