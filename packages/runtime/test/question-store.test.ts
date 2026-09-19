import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];
function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-question-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: join(dir, 'mazi.db'),
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

describe('用户问题入库与标签（QQ-C）', () => {
    it('input 投影为 user_questions；标签追加与用户覆盖', async () => {
        const dir = tmpDir();
        const runtime = new HarnessRuntime(configIn(dir));
        try {
            const created = await runtime.createGoalSession('我该怎么规划职业？', {
                userId: 'me',
                conversationId: 'conv-1',
            });
            const questions = await runtime.listQuestions({});
            expect(questions).toHaveLength(1);
            const question = questions[0];
            expect(question).toMatchObject({
                text: '我该怎么规划职业？',
                sessionId: created.rootGoalId,
                userId: 'me',
                conversationId: 'conv-1',
                derived: false,
            });

            await runtime.addQuestionLabels(question?.questionId ?? '', [
                { axis: 'domain', label: 'growth', source: 'llm', confidence: 0.9 },
                { axis: 'topic', label: 'career', source: 'llm' },
                { axis: 'category', label: 'career-plan', source: 'llm' },
            ]);
            const labelled = await runtime.getQuestion(question?.questionId ?? '');
            expect(labelled?.effective.domain).toEqual(['growth']);
            expect(labelled?.effective.topic).toEqual(['career']);
            expect(labelled?.effective.category).toEqual(['career-plan']);

            // 用户覆盖：同轴以 user 为准（旧行保留）。
            await runtime.addQuestionLabels(question?.questionId ?? '', [
                { axis: 'domain', label: 'professional', source: 'user' },
            ]);
            const overridden = await runtime.getQuestion(question?.questionId ?? '');
            expect(overridden?.effective.domain).toEqual(['professional']);
            expect(overridden?.labels.filter((row) => row.axis === 'domain')).toHaveLength(2);
        } finally {
            await runtime.close();
        }
    });

    it('查询过滤（userId / sessionId）与 clear 级联删除问题', async () => {
        const dir = tmpDir();
        const runtime = new HarnessRuntime(configIn(dir));
        try {
            const a = await runtime.createGoalSession('问题 A', { userId: 'u1' });
            await runtime.createGoalSession('问题 B', { userId: 'u2' });
            expect((await runtime.listQuestions({ userId: 'u1' })).map((q) => q.text)).toEqual([
                '问题 A',
            ]);
            expect((await runtime.listQuestions({ sessionId: a.rootGoalId })).map((q) => q.text)).toEqual([
                '问题 A',
            ]);

            await runtime.clearBehaviors(a.rootGoalId);
            expect((await runtime.listQuestions({ userId: 'u1' }))).toEqual([]);
            expect((await runtime.listQuestions({ userId: 'u2' })).map((q) => q.text)).toEqual([
                '问题 B',
            ]);
        } finally {
            await runtime.close();
        }
    });

    it('历史回填的 input 落库并标 derived', async () => {
        const dir = tmpDir();
        const runtime = new HarnessRuntime(configIn(dir));
        try {
            const created = await runtime.createGoalSession('新问题');
            await runtime.clearBehaviors(created.rootGoalId);
            await runtime.backfillBehaviorInput(created.rootGoalId, {
                input: '旧问题',
                createdAt: 1000,
            });
            const questions = await runtime.listQuestions({});
            expect(questions).toHaveLength(1);
            expect(questions[0]).toMatchObject({ text: '旧问题', derived: true, ts: 1000 });
        } finally {
            await runtime.close();
        }
    });
});
