/**
 * 对照实验接口（docs/AB测试设计.md §8.2、AB-11）。
 * 用 $MAZI_HOME 内离线 faux 驱动真跑两臂；断言实验日志折叠出的复盘视图。
 */

import 'reflect-metadata';
import { readdirSync } from 'node:fs';
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

    it('POST 执行两臂 → completed + 指标 + 对比；实验日志落盘', async () => {
        const created = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments',
            payload: SPEC,
        });
        expect(created.statusCode).toBe(200);
        const view = created.json();
        // 本用例只验 HTTP 契约与日志折叠：测试环境无可用厂商 provider，两臂以
        // driver-error 结束（执行语义由 experiments.service.test.ts 与 runtime 用例覆盖）。
        expect(view.status).toBe('completed');
        expect(view.arms).toHaveLength(2);
        expect(view.arms.map((arm: { status: string }) => arm.status)).toEqual([
            'failed',
            'failed',
        ]);
        expect(view.arms[0].rootGoalId).not.toBe(view.arms[1].rootGoalId);
        // Feature 解析仍然到达运行配置（实验日志记录了臂的有效开关）。
        expect(view.arms[1].metrics.features).toEqual({ concise: true });
        expect(view.comparison.metrics.some((m: { key: string }) => m.key === 'costUsd')).toBe(true);
        expect(view.comparison.execution).toBe('sequential');

        const logs = readdirSync(join(h.home, 'experiments')).filter((name) =>
            name.endsWith('.jsonl'),
        );
        expect(logs).toContain(view.experimentId + '.jsonl');

        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        expect(list.json().experiments[0]).toMatchObject({
            experimentId: view.experimentId,
            status: 'completed',
        });
        expect(list.json().experiments[0].arms).toHaveLength(2);
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

    it('rerun 生成新实验；DELETE 物理删除；未知 id 404', async () => {
        const list = await h.fastify.inject({ method: 'GET', url: '/api/experiments' });
        const experimentId = list.json().experiments[0].experimentId;

        const rerun = await h.fastify.inject({
            method: 'POST',
            url: '/api/experiments/' + experimentId + '/rerun',
        });
        expect(rerun.statusCode).toBe(200);
        expect(rerun.json().experimentId).not.toBe(experimentId);
        expect(rerun.json().status).toBe('completed');

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
