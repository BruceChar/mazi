export type Phase =
    | 'router'
    | 'plan'
    | 'negotiate'
    | 'think'
    | 'act'
    | 'observe'
    | 'verify'
    | 'replan'
    | 'reflect';

export const PHASES: readonly Phase[] = [
    'router',
    'plan',
    'negotiate',
    'think',
    'act',
    'observe',
    'verify',
    'replan',
    'reflect',
];

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
    /** 被 Reflect / Verify 判定失效，允许重新规划。 */
    readonly staleBy?: 'reflect' | 'verify';
}

/** Router 在 run 内产出的最小问题判定；契约条款不在这里。 */
export interface RouterSnapshot {
    readonly problemType: string;
    readonly difficulty: 'simple' | 'standard' | 'complex' | 'long-horizon';
    readonly needsPlan: boolean;
    readonly reason: string[];
}

/** Plan 的协商决定；negotiate 节点只消费，不重新判定。 */
export interface NegotiationSnapshot {
    readonly route: 'negotiate' | 'escalate';
    readonly questions: number;
    readonly reason: string;
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
    /** Router 的问题判定；Task 级 runner 缺省。 */
    router?: RouterSnapshot;
    /** Plan 决定协商时的路线；仅 negotiate 终态使用。 */
    negotiation?: NegotiationSnapshot;
    /** 本轮已安全停止，等待用户答复契约问题。 */
    awaitingNegotiation?: boolean;
    /** Verify/Reflect 申请进入 replan 节点。 */
    replanRequested?: boolean;
    /** direct 路线回答；无 Task 承载。 */
    finalAnswer?: string;
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
    /** Task 级执行完成、等待 verify 收口；旧 workflow 缺省。 */
    awaitingVerify?: boolean;
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
    /** 正常转移目标；terminal 存在时可省略。 */
    next?: Phase;
    /** 节点显式终止 loop；优先级高于 next。 */
    terminal?: Outcome;
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
    | 'awaiting-negotiation'
    | 'aborted-budget'
    | 'aborted-no-progress'
    | 'aborted-no-candidates'
    | 'failed';

export interface WorkflowEvent {
    readonly type: 'node.selected' | 'workflow.terminated' | 'node.failed';
    readonly phase: Phase;
    readonly next?: Phase;
    readonly nodeId?: string;
    /** 被选中/失败节点的角色，UI 直接按它渲染 Thinking / Acting / Observing。 */
    readonly role?: Phase;
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
