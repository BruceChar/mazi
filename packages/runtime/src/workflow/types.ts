/** 相位（typestate 的运行时等价）。 */
export type Phase = 'think' | 'act' | 'observe' | 'plan' | 'verify' | 'reflect';

export const PHASES: readonly Phase[] = ['think', 'act', 'observe', 'plan', 'verify', 'reflect'];

/** 一条收敛后的事实（Observe 的产物）。 */
export interface Fact {
    readonly id: string;
    readonly kind: 'tool' | 'note' | 'error';
    readonly text: string;
    readonly stepId?: string;
}

/** Act 产出的原始结果（未收敛）。 */
export interface RawResult {
    readonly callId: string;
    readonly ok: boolean;
    readonly text: string;
}

export interface PlanTask {
    readonly id: string;
    readonly title: string;
    readonly status: 'open' | 'done' | 'failed';
}

export interface PlanSnapshot {
    readonly version: number;
    readonly tasks: readonly PlanTask[];
    /** 被 Reflect 判定失效，允许重新规划。 */
    readonly staleBy?: 'reflect';
}

export interface WorkflowUsage {
    steps: number;
    elapsedMs: number;
    tokens: number;
    costUsd: number;
}

/** 节点之间唯一共享的载体；节点只写 delta。 */
export interface WorkflowState {
    readonly goalId: string;
    readonly statement: string;
    phase: Phase;
    plan?: PlanSnapshot;
    facts: Fact[];
    pending: RawResult[];
    acceptance: readonly string[];
    verdict: 'pending' | 'passed' | 'failed';
    failures: number;
    /** 上次 Plan 之后执行的 Act 数：防止 Plan→Think→Plan 零执行空转。 */
    actedSincePlan: number;
    usage: WorkflowUsage;
    handoff?: string;
    readonly startedAt: number;
}

/** 节点拿到的渲染视图（不是全量 transcript）。 */
export interface ContextView {
    readonly base: string;
    readonly role: string;
    readonly workingSet: string;
    readonly handoff?: string;
    readonly charBudget: number;
}

export interface NodeResult {
    delta?: Partial<WorkflowState>;
    next: Phase;
}

/**
 * 节点契约（interface 而非基类：节点无共享状态，交叉能力由 runner 承担）。
 *
 * - available：数据前置条件（能力缺失由工厂决定是否创建节点，不在此判断）
 * - run：读视图、返回 delta 与下一个相位（相位合法由 runner 校验）
 */
export interface WorkflowNode {
    readonly id: string;
    readonly role: Phase;
    readonly priority: number;
    available(state: WorkflowState): boolean;
    run(state: WorkflowState, view: ContextView): Promise<NodeResult>;
}

export type Outcome =
    | 'done'
    | 'done-unverified'
    | 'aborted-budget'
    | 'aborted-no-progress'
    | 'aborted-no-candidates'
    | 'failed';

export interface WorkflowEvent {
    readonly type: 'node.selected' | 'workflow.terminated' | 'node.failed';
    readonly phase: Phase;
    readonly next?: Phase;
    readonly nodeId?: string;
    readonly reason: string;
    readonly at: number;
}

export interface WorkflowLimits {
    /** 硬保险丝：总步数。 */
    readonly maxSteps: number;
    /** 硬保险丝：墙钟（毫秒）。 */
    readonly maxElapsedMs: number;
    /** 连续无进展步数上限。 */
    readonly maxNoProgress: number;
    /** 进入 prompt 的 facts 条数上限。 */
    readonly maxFacts: number;
}

export const DEFAULT_LIMITS: WorkflowLimits = {
    maxSteps: 50,
    maxElapsedMs: 30 * 60 * 1000,
    maxNoProgress: 4,
    maxFacts: 12,
};
