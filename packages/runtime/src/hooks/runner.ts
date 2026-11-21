import type {
    HookAuditEmitter,
    HookContext,
    HookHost,
    HookInvocationResult,
    HookPoint,
    HookRegistration,
    Unsubscribe,
} from '@mazi/core';
import { HOOK_DEFAULT_MODE, sessionStreamId } from '@mazi/core';
import { newHarnessEvent } from '../events/index.js';
import { HookDispatcher } from './dispatcher.js';

/**
 * HookRunner —— 宿主级钩子入口（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §4）。
 *
 * 职责：按点选择默认派发语义、调用 dispatcher、把每一次"有监听器参与"的调用
 * 落成审计事件。约束：
 * - 审计失败绝不影响主循环（emit 包在 try/catch 里）；
 * - 空点不产生事件，避免噪声；
 * - 没有 rootGoalId 的会话级调用以 sessionStreamId 作锚点，满足事件信封必填约束。
 */

/** 各点的默认超时预算（§4.5）；未列出的点用兜底值。 */
const TIMEOUT_BY_POINT: Partial<Record<HookPoint, number>> = {
    'session.start': 2000,
    'session.end': 5000,
    'turn.start': 2000,
    'turn.end': 5000,
    'tool.pre': 1000,
    'tool.post': 1000,
};

const FALLBACK_TIMEOUT_MS = 2000;

export interface HookRunnerOptions {
    /** 审计事件出口（铁律：钩子不得自行 emit，统一走这里）。 */
    emit: HookAuditEmitter;
    now?: () => number;
    defaultTimeoutMs?: number;
}

export class HookRunner implements HookHost {
    private readonly dispatcher: HookDispatcher;
    private readonly emitAudit: HookAuditEmitter;

    constructor(options: HookRunnerOptions) {
        this.emitAudit = options.emit;
        this.dispatcher = new HookDispatcher({
            ...(options.now !== undefined ? { now: options.now } : {}),
            defaultTimeoutMs: options.defaultTimeoutMs ?? FALLBACK_TIMEOUT_MS,
        });
    }

    register(registration: HookRegistration): Unsubscribe {
        const timeoutMs = registration.timeoutMs ?? TIMEOUT_BY_POINT[registration.point];
        return this.dispatcher.register({
            ...registration,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
    }

    listenerCount(point: HookPoint): number {
        return this.dispatcher.listenerCount(point);
    }

    async invoke(point: HookPoint, ctx: HookContext): Promise<HookInvocationResult> {
        const mode = HOOK_DEFAULT_MODE[point];
        const result = await this.dispatcher.invoke(point, ctx, mode);
        if (result.applied.length === 0) return result;

        this.audit('hook.invoked', 'debug', ctx, {
            mode: result.mode,
            listeners: result.applied.length,
            elapsedMs: result.elapsedMs,
        });
        for (const failure of result.failures) {
            this.audit(
                failure.mode === 'timeout' ? 'hook.timed_out' : 'hook.failed',
                'warn',
                ctx,
                {
                    handlerId: failure.id,
                    mode: failure.mode,
                    message: failure.message,
                },
                failure.id,
            );
        }
        if (result.decision.kind === 'block') {
            this.audit('hook.decided', 'warn', ctx, {
                decision: 'block',
                reason: result.decision.reason,
            });
        } else if (result.decision.kind === 'patch') {
            this.audit('hook.patch', 'info', ctx, {
                decision: 'patch',
                fields: Object.keys(result.decision.patch),
                ...(result.decision.reason !== undefined
                    ? { reason: result.decision.reason }
                    : {}),
            });
        }
        return result;
    }

    /**
     * 审计事件必须带一个非空 rootGoalId：执行期用 rootGoalId，会话级用会话锚点。
     * 两者都没有时放弃审计（不抛错、不阻塞）。
     */
    private audit(
        type: 'hook.invoked' | 'hook.decided' | 'hook.patch' | 'hook.failed' | 'hook.timed_out',
        level: 'debug' | 'info' | 'warn',
        ctx: HookContext,
        payload: Record<string, unknown>,
        handlerId?: string,
    ): void {
        const anchor = ctx.rootGoalId ?? (ctx.sessionId ? sessionStreamId(ctx.sessionId) : undefined);
        if (anchor === undefined) return;
        try {
            this.emitAudit(
                newHarnessEvent({
                    type,
                    rootGoalId: anchor,
                    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
                    ...(ctx.goalId !== undefined ? { goalId: ctx.goalId } : {}),
                    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
                    ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
                    attributes: {
                        'harness.level': level,
                        'harness.hook_point': ctx.hookPoint,
                        ...(handlerId !== undefined ? { 'harness.hook_id': handlerId } : {}),
                    },
                    payload,
                }),
            );
        } catch {
            // 审计失败绝不阻塞主循环。
        }
    }
}
