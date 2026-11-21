import type { HarnessEvent, Unsubscribe } from './observability.js';

/**
 * Hook contract —— 控制面契约（设计见 docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §4）。
 *
 * 与事件（事后事实、只追加、不可阻断）严格分离：钩子在事前/事中执行，
 * 可以观察、改写或阻断，但不得参与权限/预算判定，也不得改写治理面。
 */

/**
 * 钩子点闭集。新增点属于契约变更：必须同步修订设计文档与测试。
 * 未接线的点（context.assemble / compaction.pre / llm.pre / llm.post）只保留
 * 契约与派发能力，宿主接线前不得宣称生效。
 */
export const HOOK_POINTS = [
    'session.start',
    'session.end',
    'turn.start',
    'turn.end',
    'context.assemble',
    'compaction.pre',
    'tool.pre',
    'tool.post',
    'llm.pre',
    'llm.post',
] as const;

export type HookPoint = (typeof HOOK_POINTS)[number];

/** 五种派发语义（对齐 Cordis：观察 / 并发 / 串行 / 单决策 / 环绕改写）。 */
export type HookDispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall';

/**
 * 每个点的默认派发语义：
 * - emit     纯观察，不收集返回值（自动放弃决策）
 * - parallel 并发等待全部，副作用点用
 * - serial   串行等待，收集结果
 * - bail     首个非空决策胜出（拦截点用）
 * - waterfall 链式改写，可短路（注入/改写点用）
 */
export const HOOK_DEFAULT_MODE: Readonly<Record<HookPoint, HookDispatchMode>> = {
    'session.start': 'waterfall',
    'session.end': 'parallel',
    'turn.start': 'waterfall',
    'turn.end': 'parallel',
    'context.assemble': 'waterfall',
    'compaction.pre': 'waterfall',
    'tool.pre': 'bail',
    'tool.post': 'waterfall',
    'llm.pre': 'emit',
    'llm.post': 'emit',
};

export function isHookPoint(value: string): value is HookPoint {
    return (HOOK_POINTS as readonly string[]).includes(value);
}

/** 钩子调用携带的坐标（与事件信封同源；session 级调用可能没有 rootGoalId）。 */
export interface HookTrace {
    sessionId?: string;
    rootGoalId?: string;
    goalId?: string;
    taskId?: string;
    stepId?: string;
    /** turn 标识；当前与 rootGoalId 一致，保留字段以便未来多 Goal 轮次。 */
    turnId?: string;
}

/** 单次钩子调用上下文。payload 为该点的只读输入，改写通过返回值 patch 完成。 */
export interface HookContext extends HookTrace {
    hookPoint: HookPoint;
    payload: Readonly<Record<string, unknown>>;
    /** waterfall 点：此前 handler 已累积的 patch（只读，便于链式改写）。 */
    accumulated?: Readonly<Record<string, unknown>>;
    signal?: AbortSignal;
}

/**
 * 钩子决策。
 * - block 只对 pre 类点生效；post 类点上的 block 会被降级为 continue 并记审计。
 * - patch 只允许白名单字段，未知字段丢弃。
 */
export type HookDecision =
    | { kind: 'continue' }
    | { kind: 'block'; reason: string }
    | { kind: 'patch'; patch: Readonly<Record<string, unknown>>; reason?: string };

/** 单个 handler 的结果：void / undefined 等价于 continue。 */
export type HookHandlerOutput = HookDecision | void | undefined;

/**
 * 钩子注册。
 * - priority 越小越先执行；同优先级按注册顺序（先注册先执行）。
 * - timeoutMs 缺省由宿主按点决定；超时按 onError 处理。
 * - onError='fail' 时，pre 点的异常/超时转为 block（fail-closed）；其余情况隔离。
 */
export interface HookRegistration {
    id: string;
    point: HookPoint;
    priority?: number;
    timeoutMs?: number;
    onError?: 'isolate' | 'fail';
    handle: (ctx: HookContext) => HookHandlerOutput | Promise<HookHandlerOutput>;
}

/** handler 级失败记录（超时与异常分开，便于监控区分）。 */
export interface HookHandlerFailure {
    id: string;
    mode: 'error' | 'timeout';
    message: string;
}

/** 单次调用结果。 */
export interface HookInvocationResult {
    point: HookPoint;
    mode: HookDispatchMode;
    decision: HookDecision;
    /** 实际执行过的 handler id（按执行顺序）。 */
    applied: string[];
    failures: HookHandlerFailure[];
    elapsedMs: number;
}

/** 钩子宿主：注册可撤销，调用返回聚合决策。 */
export interface HookHost {
    register(registration: HookRegistration): Unsubscribe;
    invoke(point: HookPoint, ctx: HookContext): Promise<HookInvocationResult>;
    /** 某点当前注册数量（监控与测试用）。 */
    listenerCount(point: HookPoint): number;
}

/** 事件桥接：钩子的每次决策必须落审计事件（由宿主实现，禁止钩子自行 emit）。 */
export type HookAuditEmitter = (event: HarnessEvent) => void;
