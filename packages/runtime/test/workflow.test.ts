import { describe, expect, it } from 'vitest';
import { buildContextView, createBuiltinNodes } from '../src/workflow/index.js';
import { WorkflowRunner } from '../src/workflow/runner.js';
import { IllegalTransitionError, TRANSITIONS, assertTransition } from '../src/workflow/transitions.js';
import {
    DEFAULT_LIMITS,
    type PromptSections,
    type WorkflowHost,
    type WorkflowNode,
    type WorkflowState,
} from '../src/workflow/index.js';

const SECTIONS: PromptSections = {
    base: 'BASE',
    byRole: {
        router: 'ROUTER',
        negotiate: 'NEGOTIATE',
        think: 'THINK',
        act: 'ACT',
        observe: 'OBSERVE',
        plan: 'PLAN',
        verify: 'VERIFY',
        replan: 'REPLAN',
        reflect: 'REFLECT',
    },
};

function makeRunner(
    nodes: readonly WorkflowNode[],
    limits = DEFAULT_LIMITS,
): WorkflowRunner {
    return new WorkflowRunner(nodes, SECTIONS, limits, () => 0);
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
    return {
        goalId: 'g1',
        statement: 'ship it',
        phase: 'think',
        facts: [],
        pending: [],
        acceptance: [],
        verdict: 'pending',
        failures: 0,
        actedSincePlan: 0,
        usage: { steps: 0, elapsedMs: 0, tokens: 0, costUsd: 0 },
        startedAt: 0,
        ...overrides,
    };
}

describe('相位转移表', () => {
    it('表内每一条边都能通过断言，表外一律拒绝', () => {
        for (const [from, targets] of Object.entries(TRANSITIONS)) {
            for (const to of targets) assertTransition(from as WorkflowState['phase'], to);
        }
        expect(() => assertTransition('think', 'think')).toThrow(IllegalTransitionError);
        expect(() => assertTransition('act', 'act')).toThrow(IllegalTransitionError);
    });

    it('Act 之后只能 Observe', () => {
        expect(TRANSITIONS.act).toEqual(['observe']);
    });
});

describe('内置节点', () => {
    const host: WorkflowHost = {
        think: async () => ({ next: 'act' }),
        act: async () => ({ next: 'observe' }),
    };

    it('缺 plan/verify 时不创建对应节点（自动降级），observe/reflect 恒存在', () => {
        const nodes = createBuiltinNodes(host, DEFAULT_LIMITS);
        expect(nodes.map((node) => node.id).sort()).toEqual(['act', 'observe', 'reflect', 'think']);
    });

    it('Observe 是确定性实现：pending 收敛为 facts，按 maxFacts 截断并保留 ok/error', async () => {
        const nodes = createBuiltinNodes(host, { ...DEFAULT_LIMITS, maxFacts: 2 });
        const observe = nodes.find((node) => node.id === 'observe');
        const state = makeState({
            facts: [{ id: 'f0', kind: 'note', text: 'old' }],
            pending: [
                { callId: 'a', ok: true, text: 'ok-1' },
                { callId: 'b', ok: false, text: 'bad' },
            ],
        });
        expect(observe?.requires(state)).toBe(true);
        const result = await observe?.run(state, buildContextView(state, 'observe', SECTIONS, 12));
        expect(result?.next).toBe('think');
        const facts = result?.delta?.facts ?? [];
        expect(facts).toHaveLength(2);
        expect(facts[0]?.kind).toBe('tool');
        expect(facts[1]?.kind).toBe('error');
        expect(result?.delta?.pending).toEqual([]);
    });

    it('失败≥2 时 Reflect 让计划 stale 并请求重新规划', async () => {
        const nodes = createBuiltinNodes(host, DEFAULT_LIMITS);
        const reflect = nodes.find((node) => node.id === 'reflect');
        const state = makeState({
            failures: 2,
            plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
        });
        const result = await reflect?.run(state, buildContextView(state, 'reflect', SECTIONS, 12));
        expect(result?.next).toBe('plan');
        expect(result?.delta?.plan?.staleBy).toBe('reflect');
    });

    it('Plan 需要进展：有计划、有开放任务、零执行、未 stale 时不可用', () => {
        const withPlan = createBuiltinNodes(
            { ...host, plan: async () => ({ next: 'think' }) },
            DEFAULT_LIMITS,
        );
        const planNode = withPlan.find((node) => node.id === 'plan');
        const state = makeState({
            plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
        });
        expect(planNode?.requires(state)).toBe(false);
        expect(planNode?.requires({ ...state, actedSincePlan: 1 })).toBe(true);
        expect(planNode?.requires({ ...state, plan: { ...state.plan!, staleBy: 'reflect' } })).toBe(
            true,
        );
    });

    it('宿主 observe 钩子在 facts 收敛前执行', async () => {
        const observed: number[] = [];
        const nodes = createBuiltinNodes(
            {
                ...host,
                observe: async (state) => {
                    observed.push(state.pending.length);
                },
            },
            DEFAULT_LIMITS,
        );
        const observe = nodes.find((node) => node.id === 'observe');
        const state = makeState({
            pending: [{ callId: 'a', ok: true, text: 'ok' }],
        });
        const result = await observe?.run(state, buildContextView(state, 'observe', SECTIONS, 12));
        expect(observed).toEqual([1]);
        expect(result?.delta?.pending).toEqual([]);
    });

    it('awaitingVerify 让 Verify 在当前 Task 尚未关闭时也可执行', async () => {
        const nodes = createBuiltinNodes(
            { ...host, verify: async () => ({ delta: { verdict: 'passed' }, next: 'think' }) },
            DEFAULT_LIMITS,
        );
        const verify = nodes.find((node) => node.id === 'verify');
        const state = makeState({
            awaitingVerify: true,
            plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
        });
        expect(verify?.requires(state)).toBe(true);
    });

    it('terminal 立即结束 loop，不再要求 next 或合法转移', async () => {
        const nodes: WorkflowNode[] = [
            {
                id: 'think',
                role: 'think',
                priority: 1,
                requires: () => true,
                run: async () => ({ terminal: 'failed' }),
            },
        ];
        const result = await makeRunner(nodes).run(makeState());
        expect(result.outcome).toBe('failed');
        expect(result.state.usage.steps).toBe(1);
        expect(result.events.at(-1)?.reason).toBe('failed');
    });

    it('缺 Verify 且验收非空时只落到 done-unverified', async () => {
        const runner = makeRunner(createBuiltinNodes(host, DEFAULT_LIMITS));
        const result = await runner.run(makeState({ acceptance: ['tests pass'] }));
        expect(result.outcome).toBe('done-unverified');
    });
});

describe('WorkflowRunner 循环', () => {
    const host: WorkflowHost = {
        think: async (state) =>
            state.facts.length === 0
                ? { next: 'act' }
                : {
                      delta: {
                          plan: {
                              version: 1,
                              tasks: [{ id: 't1', title: 'run tool', status: 'done' }],
                          },
                      },
                      next: 'act',
                  },
        act: async () => ({
            delta: { pending: [{ callId: 'c1', ok: false, text: 'boom' }] },
            next: 'observe',
        }),
    };

    it('Think→Act→Observe→Think 后由 runner 判定 done', async () => {
        const runner = makeRunner(createBuiltinNodes(host, DEFAULT_LIMITS));
        const result = await runner.run(
            makeState({
                plan: { version: 1, tasks: [{ id: 't1', title: 'run tool', status: 'open' }] },
            }),
        );
        expect(result.outcome).toBe('done');
        expect(result.state.usage.steps).toBe(4);
        expect(result.state.facts).toHaveLength(1);
        // Think 的 next=act 表示「下一步该执行 act」，收尾时停在 act。
        expect(result.state.phase).toBe('act');
        expect(result.events.at(-1)?.reason).toBe('done');
    });

    it('Verify 可用且通过时先验收再结束', async () => {
        const runner = makeRunner(
            createBuiltinNodes(
                {
                    ...host,
                    think: async () => ({ next: 'verify' }),
                    verify: async () => ({ delta: { verdict: 'passed' }, next: 'think' }),
                },
                DEFAULT_LIMITS,
            ),
        );
        const result = await runner.run(makeState({ acceptance: ['tests pass'] }));
        expect(result.outcome).toBe('done');
        expect(result.state.verdict).toBe('passed');
    });

    it('无进展的一对节点会在 maxNoProgress 内被终止', async () => {
        const pingPong: WorkflowNode[] = [
            {
                id: 'p',
                role: 'think',
                priority: 1,
                requires: () => true,
                run: async () => ({ next: 'plan' }),
            },
            {
                id: 'q',
                role: 'plan',
                priority: 1,
                requires: () => true,
                run: async () => ({ next: 'think' }),
            },
        ];
        const runner = makeRunner(pingPong, { ...DEFAULT_LIMITS, maxNoProgress: 3 });
        const result = await runner.run(
            makeState({
                acceptance: ['never verified'],
                plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
            }),
        );
        expect(result.outcome).toBe('aborted-no-progress');
    });

    it('步数保险丝生效', async () => {
        const nodes: WorkflowNode[] = [
            {
                id: 'a',
                role: 'think',
                priority: 1,
                requires: () => true,
                run: async (state) => ({
                    delta: { facts: [...state.facts, { id: `f${state.usage.steps}`, kind: 'note', text: 'x' }] },
                    next: 'act',
                }),
            },
            { id: 'b', role: 'act', priority: 1, requires: () => true, run: async () => ({ next: 'observe' }) },
            {
                id: 'c',
                role: 'observe',
                priority: 1,
                requires: () => true,
                run: async () => ({ delta: { pending: [] }, next: 'think' }),
            },
        ];
        const runner = makeRunner(nodes, { ...DEFAULT_LIMITS, maxSteps: 2 });
        const result = await runner.run(
            makeState({
                acceptance: ['x'],
                plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
            }),
        );
        expect(result.outcome).toBe('aborted-budget');
        expect(result.state.usage.steps).toBe(2);
    });

    it('节点返回非法下一相位时抛错，节点抛异常时 outcome=failed', async () => {
        const bad: WorkflowNode[] = [
            { id: 'bad', role: 'act', priority: 1, requires: () => true, run: async () => ({ next: 'think' }) },
        ];
        const runner = makeRunner(bad);
        await expect(
            runner.run(
                makeState({
                    acceptance: ['x'],
                    plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
                }),
            ),
        ).rejects.toThrow(IllegalTransitionError);

        const throwing: WorkflowNode[] = [
            {
                id: 'boom',
                role: 'act',
                priority: 1,
                requires: () => true,
                run: async () => {
                    throw new Error('provider down');
                },
            },
        ];
        const failed = await makeRunner(throwing).run(
            makeState({
                acceptance: ['x'],
                plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
            }),
        );
        expect(failed.outcome).toBe('failed');
        expect(failed.events.at(-1)?.type).toBe('node.failed');
    });

    it('无候选节点时立即终止', async () => {
        const none: WorkflowNode[] = [];
        const result = await makeRunner(none).run(
            makeState({
                acceptance: ['x'],
                plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
            }),
        );
        expect(result.outcome).toBe('aborted-no-candidates');
    });

    it('视图三段可拼装，且工作集只带最近 K 条事实', () => {
        const state = makeState({
            facts: Array.from({ length: 5 }, (_, index) => ({
                id: `f${index}`,
                kind: 'note' as const,
                text: `fact-${index}`,
            })),
        });
        const view = buildContextView(state, 'think', SECTIONS, 2);
        expect(view.base).toBe('BASE');
        expect(view.role).toBe('THINK');
        expect(view.workingSet).toContain('fact-4');
        expect(view.workingSet).not.toContain('fact-2');
    });
});

describe('编排节点：Router / Negotiate / Replan', () => {
    it('初始 phase=router 时 Router 先执行，随后进入 Plan', async () => {
        const nodes = createBuiltinNodes(
            {
                router: async () => ({
                    delta: {
                        router: {
                            problemType: 'research',
                            difficulty: 'complex',
                            needsPlan: true,
                            reason: ['multi-source'],
                        },
                    },
                    next: 'plan',
                }),
                plan: async () => ({
                    delta: {
                        plan: {
                            version: 1,
                            tasks: [{ id: 't1', title: 'do', status: 'open' }],
                        },
                    },
                    next: 'think',
                }),
                negotiate: async () => ({ terminal: 'awaiting-negotiation' }),
                verify: async () => ({ next: 'think' }),
                think: async () => ({ terminal: 'done' }),
                act: async () => ({ next: 'observe' }),
            },
            DEFAULT_LIMITS,
        );
        const state = makeState({ phase: 'router', acceptance: ['x'] });
        const result = await makeRunner(nodes).run(state);
        const roles = result.events
            .filter((event) => event.type === 'node.selected')
            .map((event) => event.role);
        expect(roles[0]).toBe('router');
        expect(roles[1]).toBe('plan');
        expect(roles[2]).toBe('think');
        expect(result.outcome).toBe('done');
    });

    it('Plan 决定协商时转到 Negotiate，并以 awaiting-negotiation 终止', async () => {
        const nodes = createBuiltinNodes(
            {
                plan: async () => ({
                    delta: {
                        awaitingNegotiation: true,
                        negotiation: { route: 'negotiate', questions: 1, reason: 'ambiguous' },
                    },
                    next: 'negotiate',
                }),
                negotiate: async () => ({ terminal: 'awaiting-negotiation' }),
                verify: async () => ({ next: 'think' }),
                think: async () => ({ terminal: 'done' }),
                act: async () => ({ next: 'observe' }),
            },
            DEFAULT_LIMITS,
        );
        const state = makeState({ phase: 'plan', acceptance: ['x'] });
        const result = await makeRunner(nodes).run(state);
        expect(result.outcome).toBe('awaiting-negotiation');
        expect(result.events.some((event) => event.role === 'negotiate')).toBe(true);
    });

    it('Replan 只在显式请求时可用；Reflect 请求失败诊断后进入 Replan', async () => {
        const nodes = createBuiltinNodes(
            {
                replan: async () => ({
                    delta: { replanRequested: false, plan: { version: 2, tasks: [] } },
                    next: 'think',
                }),
                think: async () => ({ terminal: 'done' }),
                act: async () => ({ next: 'observe' }),
            },
            DEFAULT_LIMITS,
        );
        const replanNode = nodes.find((node) => node.id === 'replan');
        const at = makeState({
            failures: 2,
            plan: { version: 1, tasks: [{ id: 't1', title: 'do', status: 'open' }] },
        });
        expect(replanNode?.requires(at)).toBe(false);
        const reflect = nodes.find((node) => node.id === 'reflect');
        const reflected = await reflect?.run(
            at,
            buildContextView(at, 'reflect', SECTIONS, 12),
        );
        expect(reflected?.next).toBe('replan');
        expect(reflected?.delta?.replanRequested).toBe(true);
        expect(replanNode?.requires({ ...at, replanRequested: true })).toBe(true);
    });
});
