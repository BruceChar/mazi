import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { SessionsService } from '../src/sessions/sessions.service.js';

/** 直接单测 conversationHistory：run 列表 → user/assistant 消息（不依赖真实 provider）。 */
describe('SessionsService.conversationHistory（Conversation 共享上下文组装）', () => {
    function serviceWith(
        runs: Array<{ rootGoalId: string; input: string; createdAt: number }>,
        answers: Record<string, string>,
    ): SessionsService {
        const conversations = {
            runs: () => runs,
        };
        const runtime = {
            harness: () => ({
                goalSnapshot: async (rootGoalId: string) => ({
                    goals: [
                        {
                            tasks: [
                                {
                                    steps: [
                                        { kind: 'thinking', content: 'ignored' },
                                        { kind: 'intent', content: answers[rootGoalId] ?? '' },
                                    ],
                                },
                            ],
                        },
                    ],
                }),
            }),
        };
        return new SessionsService(runtime as never, conversations as never);
    }

    it('按时间顺序输出 user 输入 + assistant 最终回答', async () => {
        const service = serviceWith(
            [
                { rootGoalId: 'r1', input: 'q1', createdAt: 1 },
                { rootGoalId: 'r2', input: 'q2', createdAt: 2 },
            ],
            { r1: 'a1', r2: 'a2' },
        );
        const history = await (
            service as unknown as {
                conversationHistory: (id: string) => Promise<unknown>;
            }
        ).conversationHistory('c1');
        expect(history).toEqual([
            { role: 'user', text: 'q1' },
            { role: 'assistant', text: 'a1' },
            { role: 'user', text: 'q2' },
            { role: 'assistant', text: 'a2' },
        ]);
    });

    it('createSession 透传 goal.reasoningLevel 到 createGoalSession', async () => {
        const captured: Array<Record<string, unknown>> = [];
        const conversations = {
            runs: () => [],
            recordNewRun: () => 'c1',
            appendRun: () => {},
        };
        const runtime = {
            selectedWorkspaceRoot: undefined,
            setWorkspaceRoot: () => {},
            harness: () => ({
                createGoalSession: async (_input: string, opts: Record<string, unknown>) => {
                    captured.push(opts);
                    return { rootGoalId: 'r1', goalId: 'g1' };
                },
            }),
        };
        const service = new SessionsService(runtime as never, conversations as never);
        await service.createSession({
            input: 'hi',
            goal: { reasoningLevel: 'high', modelId: 'deepseek-v4-pro' },
        });
        expect(captured[0]?.reasoningLevel).toBe('high');
        expect(captured[0]?.modelId).toBe('deepseek-v4-pro');
    });

    it('无最终回答时只输出 user 输入', async () => {
        const service = serviceWith([{ rootGoalId: 'r1', input: 'q1', createdAt: 1 }], {});
        const history = await (
            service as unknown as {
                conversationHistory: (id: string) => Promise<unknown>;
            }
        ).conversationHistory('c1');
        expect(history).toEqual([{ role: 'user', text: 'q1' }]);
    });
});
