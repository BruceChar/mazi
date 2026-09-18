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
                                        {
                                            kind: 'deliberation',
                                            content: answers[rootGoalId] ?? '',
                                        },
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

    it('把已执行工具摘要并入 assistant 历史，避免下一会话重复执行', async () => {
        const conversations = {
            runs: () => [{ rootGoalId: 'r1', input: 'ls', createdAt: 1 }],
        };
        const runtime = {
            harness: () => ({
                goalSnapshot: async () => ({
                    goals: [
                        {
                            tasks: [
                                {
                                    steps: [
                                        { kind: 'deliberation', content: '已完成' },
                                        {
                                            kind: 'invocation',
                                            toolName: 'shell.run',
                                            toolArguments: { command: 'ls' },
                                            toolOutput: '[ok] (no output)',
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                }),
            }),
        };
        const service = new SessionsService(runtime as never, conversations as never);
        const history = await (
            service as unknown as {
                conversationHistory: (id: string) => Promise<unknown>;
            }
        ).conversationHistory('c1');
        expect(history).toEqual([
            { role: 'user', text: 'ls' },
            {
                role: 'assistant',
                text: '已完成\n\n[已执行工具]\n- shell.run({"command":"ls"}) → [ok] (no output)',
            },
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
            resolvePermission: () => 'workspace-write',
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
        // No client hint → the backend resolves the scoped effective permission.
        expect(captured[0]?.permissionCeiling).toBe('workspace-write');
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

    it('taskThinkingChain：导出该 Task 的 thinking 链（renderThinkingChain）', async () => {
        const runtime = {
            harness: () => ({
                goalSnapshot: async () => ({
                    goals: [
                        {
                            tasks: [
                                {
                                    taskId: 't1',
                                    steps: [
                                        step({ kind: 'deliberation', startedAt: 1, thinking: 'first' }),
                                        step({
                                            kind: 'invocation',
                                            startedAt: 2,
                                            toolName: 'shell.run',
                                            toolArguments: { command: 'ls' },
                                            toolOutput: '',
                                        }),
                                        step({
                                            kind: 'deliberation',
                                            startedAt: 3,
                                            thinking: 'second',
                                            answer: 'done',
                                        }),
                                    ],
                                },
                            ],
                        },
                    ],
                }),
            }),
        };
        const service = new SessionsService(runtime as never, {} as never);
        const result = await service.taskThinkingChain('r1', 't1');
        expect(result).toEqual({
            sessionId: 'r1',
            taskId: 't1',
            steps: 3,
            text: '1. first\n   ↳ shell.run {"command":"ls"} → (空)\n2. second\n\ndone',
        });
    });

    it('taskThinkingChain：未知 task → 404', async () => {
        const runtime = {
            harness: () => ({ goalSnapshot: async () => ({ goals: [] }) }),
        };
        const service = new SessionsService(runtime as never, {} as never);
        await expect(service.taskThinkingChain('r1', 'missing')).rejects.toThrow('task not found');
    });
});

function step(over: Record<string, unknown>): Record<string, unknown> {
    return { stepId: 's', goalId: 'g', taskId: 't1', status: 'succeeded', ...over };
}
