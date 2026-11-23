export type Phase = 'think' | 'act' | 'observe' | 'plan' | 'verify' | 'reflect';

export const PHASES: readonly Phase[] = ['think', 'act', 'observe', 'plan', 'verify', 'reflect'];

export interface ObserveFact {
    readonly id: string;
    readonly kind: 'tool' | 'note' | 'error';
    readonly text: string;
    readonly stepId?: string;
}

export interface ActRawResult {
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

/**
 * RunState：一次运行的事实与资源，可持久化、可跨 lane 共享。
 * 不含「现在走到哪个相位」这类游标，因此可恢复、可被多个 workflow 投影。
 */
export interface RunState {
    readonly goalId: string;
    readonly statement: string;
    plan?: PlanSnapshot;
    facts: ObserveFact[];
    pending: ActRawResult[];
    acceptance: readonly string[];
    verdict: 'pending' | 'passed' | 'failed';
    failures: number;
    usage: WorkflowUsage;
}

/**
 * WorkflowState = RunState 快照 + 本 loop 的游标。
 *
 * 节点只看到 WorkflowState；持久化与跨 lane 共享只认 RunState。
 */
export interface WorkflowState extends RunState {
    phase: Phase;
    /** 上次 Plan 之后执行的 Act 数：防止 Plan→Think→Plan 零执行空转。 */
    actedSincePlan: number;
    /** 点对点交接，≤200 token，仅本 loop 有效。 */
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
 * - requires：数据前置条件（能力缺失由工厂决定是否创建节点，不在此判断）
 * - run：读视图、返回 delta 与下一个相位（相位合法由 runner 校验）
 */
export interface WorkflowNode {
    readonly id: string;
    readonly role: Phase;
    readonly priority: number;
    requires(state: WorkflowState): boolean;
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
    maxElapsedMs: 15 * 60 * 1000,
    maxNoProgress: 4,
    maxFacts: 12,
};
