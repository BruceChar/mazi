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
    think(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    act(state: WorkflowState, view: ContextView): Promise<NodeResult>;
    plan?(state: WorkflowState, view: ContextView): Promise<NodeResult>;
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
            run: (state) => {
                const facts = state.pending.map((item, index) => ({
                    id: `${item.callId}:${index}`,
                    kind: item.ok ? ('tool' as const) : ('error' as const),
                    text: item.text,
                }));
                return Promise.resolve({
                    delta: {
                        facts: [...state.facts, ...facts].slice(-limits.maxFacts),
                        pending: [],
                    },
                    next: 'think',
                });
            },
        },
        {
            id: 'reflect',
            role: 'reflect',
            priority: 2,
            requires: (state) => state.failures >= 2,
            run: (state): Promise<NodeResult> =>
                Promise.resolve(
                    hasPlan(state) && state.plan.staleBy !== 'reflect'
                        ? {
                              delta: { plan: { ...state.plan, staleBy: 'reflect' } },
                              next: 'plan',
                          }
                        : { next: 'think' },
                ),
        },
    ];
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
    if (host.verify !== undefined) {
        const verify = host.verify;
        nodes.push({
            id: 'verify',
            role: 'verify',
            priority: 3,
            requires: (state) =>
                state.acceptance.length > 0 &&
                openTaskCount(state) === 0 &&
                state.pending.length === 0,
            run: (state, view) => verify(state, view),
        });
    }
    return nodes;
}
