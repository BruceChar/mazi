import type {
    ContextView,
    NodeResult,
    PlanSnapshot,
    WorkflowLimits,
    WorkflowNode,
    WorkflowState,
} from './types.js';

/** 宿主执行器：能力注入的唯一入口（缺 plan/verify 即降级，不是开关）。 */
export interface WorkflowHost {
    /** 可选：统一入口的问题判定；缺失时从 plan 或 think 开始（Task 级 runner 不创建）。 */
    router?(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    think(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    act(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    /** 可选：在确定性 facts 收敛之前执行副作用，并可指定下一步或终止。 */
    observe?(state: WorkflowState, view: ContextView): Promise<NodeResult | undefined>;
    plan?(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    /** 可选：Plan 决定协商后，落 blocked 并终止本轮等待答复。 */
    negotiate?(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    /** 可选：run 内重规划；缺失时失败不自动改写计划。 */
    replan?(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    verify?(state: WorkflowState, view: ContextView): Promise<NodeResult>;
}

export function openTaskCount(state: WorkflowState): number {
    return state.plan?.tasks.filter((task) => task.status === 'open').length ?? 0;
}

function hasPlan(state: WorkflowState): state is WorkflowState & { plan: PlanSnapshot } {
    return state.plan !== undefined;
}

/** 内置节点工厂：think/act 必需，plan/verify 缺省即不创建（自动降级）。 */
export function createBuiltinNodes(host: WorkflowHost, limits: WorkflowLimits): WorkflowNode[] {
    const nodes: WorkflowNode[] = [
        {
            id: 'think',
            role: 'think',
            priority: 7,
            requires: () => true,
            run: (state, view) => host.think(state, view),
        },
        {
            id: 'act',
            role: 'act',
            priority: 5,
            // 上一批结果还没被 Observe 吸收时不许再 Act，否则会重复执行。
            requires: (state) => state.pending.length === 0,
            run: (state, view) => host.act(state, view),
        },
        {
            id: 'observe',
            role: 'observe',
            priority: 6,
            requires: (state) => state.pending.length > 0,
            run: async (state, view) => {
                const observed = await host.observe?.(state, view);
                if (observed?.terminal !== undefined) return observed;
                const facts = state.pending.map((item, index) => ({
                    id: `${item.callId}:${index}`,
                    kind: item.ok ? ('tool' as const) : ('error' as const),
                    text: item.text,
                }));
                return {
                    delta: {
                        ...observed?.delta,
                        facts: [...state.facts, ...facts].slice(-limits.maxFacts),
                        pending: [],
                    },
                    next: observed?.next ?? 'think',
                };
            },
        },
        {
            id: 'reflect',
            role: 'reflect',
            priority: 2,
            requires: (state) => state.failures >= 2,
            run: (state): Promise<NodeResult> => {
                const next = host.replan !== undefined ? 'replan' : 'plan';
                return Promise.resolve(
                    hasPlan(state) && state.plan.staleBy !== 'reflect'
                        ? {
                              delta: {
                                  plan: { ...state.plan, staleBy: 'reflect' },
                                  ...(next === 'replan' ? { replanRequested: true } : {}),
                              },
                              next,
                          }
                        : { next: host.replan !== undefined ? 'replan' : 'think' },
                );
            },
        },
    ];
    if (host.router !== undefined) {
        const router = host.router;
        nodes.push({
            id: 'router',
            role: 'router',
            priority: 0,
            requires: (state) => state.router === undefined,
            run: (state, view) => router(state, view),
        });
    }
    if (host.plan !== undefined) {
        const plan = host.plan;
        nodes.push({
            id: 'plan',
            role: 'plan',
            priority: 4,
            requires: (state) =>
                state.plan === undefined ||
                openTaskCount(state) === 0 ||
                state.plan?.staleBy === 'reflect' ||
                state.actedSincePlan > 0,
            run: (state, view) => plan(state, view),
        });
    }
    if (host.negotiate !== undefined) {
        const negotiate = host.negotiate;
        nodes.push({
            id: 'negotiate',
            role: 'negotiate',
            priority: 1,
            requires: (state) => state.awaitingNegotiation === true,
            run: (state, view) => negotiate(state, view),
        });
    }
    if (host.replan !== undefined) {
        const replan = host.replan;
        nodes.push({
            id: 'replan',
            role: 'replan',
            priority: 3,
            requires: (state) => state.replanRequested === true,
            run: (state, view) => replan(state, view),
        });
    }
    if (host.verify !== undefined) {
        const verify = host.verify;
        nodes.push({
            id: 'verify',
            role: 'verify',
            priority: 3,
            requires: (state) =>
                state.awaitingVerify === true ||
                (state.acceptance.length > 0 &&
                    openTaskCount(state) === 0 &&
                    state.pending.length === 0),
            run: (state, view) => verify(state, view),
        });
    }
    return nodes;
}
