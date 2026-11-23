import { buildContextView, type PromptSections } from './context-view.js';
import { openTaskCount } from './nodes.js';
import { assertTransition, canEnterPhase } from './transitions.js';
import {
    DEFAULT_LIMITS,
    type Outcome,
    PHASES,
    type WorkflowEvent,
    type WorkflowLimits,
    type WorkflowNode,
    type WorkflowState,
} from './types.js';

export interface WorkflowRunResult {
    readonly state: WorkflowState;
    readonly outcome: Outcome;
    readonly events: readonly WorkflowEvent[];
}

/** 进展签名：开放任务数 / 计划版本 / facts 数 / 待吸收结果数。 */
function progressSignature(state: WorkflowState): string {
    return `${openTaskCount(state)}|${state.plan?.version ?? -1}|${state.facts.length}|${state.pending.length}`;
}

function applyDelta(
    state: WorkflowState,
    delta: Partial<WorkflowState> | undefined,
): WorkflowState {
    return {
        ...state,
        ...delta,
        phase: delta?.phase ?? state.phase,
        usage: { ...state.usage, ...(delta?.usage ?? {}) },
    };
}

/**
 * 渐进式 workflow 的循环本体。
 *
 * 只做四件事：选节点（表 + requires + priority）、执行、记账、判定终止。
 * 节点不宣布完成，不越权改相位——这两件事都由这里说了算。
 */
export class WorkflowRunner {
    private readonly nodes: readonly WorkflowNode[];

    constructor(
        nodes: readonly WorkflowNode[],
        private readonly sections: PromptSections,
        private readonly limits: WorkflowLimits = DEFAULT_LIMITS,
        private readonly now: () => number = Date.now,
        private readonly onEvent?: (event: WorkflowEvent) => void,
    ) {
        for (const node of nodes) {
            if (!PHASES.includes(node.role)) throw new Error(`节点 ${node.id} 的相位非法`);
        }
        this.nodes = [...nodes].sort((a, b) => a.priority - b.priority);
    }

    private hasVerify(): boolean {
        return this.nodes.some((node) => node.role === 'verify');
    }

    /** 只由 runner 判定完成：开放任务清零 + 无待吸收结果 + 验收通过（或有标准但无验收能力）。 */
    private completion(state: WorkflowState): Outcome | undefined {
        if (openTaskCount(state) > 0 || state.pending.length > 0) return undefined;
        // 空验收 + 尚未执行任何节点，不能算完成：否则「还没开始」会被判成「做完了」。
        if (state.acceptance.length === 0) return state.usage.steps > 0 ? 'done' : undefined;
        if (state.verdict === 'passed') return 'done';
        if (state.verdict === 'failed') return undefined;
        return this.hasVerify() ? undefined : 'done-unverified';
    }

    private record(events: WorkflowEvent[], event: WorkflowEvent): void {
        events.push(event);
        this.onEvent?.(event);
    }

    async run(initial: WorkflowState): Promise<WorkflowRunResult> {
        let state: WorkflowState = { ...initial, usage: { ...initial.usage } };
        const events: WorkflowEvent[] = [];
        let noProgress = 0;
        let signature = progressSignature(state);
        /** 上一个已执行的相位；用于校验「进入」这一跳，初始无。 */
        let last: WorkflowState['phase'] | undefined;

        const terminate = (outcome: Outcome): WorkflowRunResult => {
            this.record(events, {
                type: 'workflow.terminated',
                phase: state.phase,
                reason: outcome,
                at: this.now(),
            });
            return { state, outcome, events };
        };

        while (true) {
            const done = this.completion(state);
            if (done !== undefined) return terminate(done);
            if (state.usage.steps >= this.limits.maxSteps) return terminate('aborted-budget');
            if (this.now() - state.startedAt >= this.limits.maxElapsedMs)
                return terminate('aborted-budget');

            // phase 是「本步要执行的节点角色」。首步优先 Think 做决策；
            // 进入这一跳由 last → phase 校验，输出那跳由 node → next 校验。
            const node =
                last === undefined
                    ? (this.nodes.find(
                          (candidate) => candidate.role === 'think' && candidate.requires(state),
                      ) ?? this.nodes.find((candidate) => candidate.requires(state)))
                    : this.nodes.find(
                          (candidate) =>
                              candidate.role === state.phase && candidate.requires(state),
                      );
            if (node === undefined) return terminate('aborted-no-candidates');

            this.record(events, {
                type: 'node.selected',
                phase: state.phase,
                next: node.role,
                nodeId: node.id,
                role: node.role,
                reason: `${last ?? 'start'}→${node.role}`,
                at: this.now(),
            });
            if (last !== undefined) assertTransition(last, node.role);

            const view = buildContextView(state, node.role, this.sections, this.limits.maxFacts);
            let result: { delta?: Partial<WorkflowState>; next: WorkflowState['phase'] };
            try {
                result = await node.run(state, view);
            } catch (error) {
                this.record(events, {
                    type: 'node.failed',
                    phase: state.phase,
                    next: node.role,
                    nodeId: node.id,
                    role: node.role,
                    reason: error instanceof Error ? error.message : String(error),
                    at: this.now(),
                });
                return { state, outcome: 'failed', events };
            }
            assertTransition(node.role, result.next);
            last = node.role;

            state = applyDelta({ ...state, phase: result.next }, result.delta);
            state.usage.steps += 1;
            state.usage.elapsedMs = this.now() - state.startedAt;

            const nextSignature = progressSignature(state);
            if (nextSignature === signature) noProgress += 1;
            else {
                noProgress = 0;
                signature = nextSignature;
            }
            if (noProgress >= this.limits.maxNoProgress) return terminate('aborted-no-progress');
        }
    }
}
