import { sessionStreamId } from '@mazi/core';
import type { DefaultEventBus } from '../events/index.js';
import { newHarnessEvent } from '../events/index.js';
import type { GoalRunResult } from '../strategy/goal-strategy.js';
import type { HookRunner } from './runner.js';

/**
 * 会话/轮次生命周期（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §3.3）。
 *
 * 把"发哪些事件、在哪个边界跑哪些钩子"从 HarnessRuntime 抽出来：
 * - 事实（session.started/ended、turn.started/ended）总是发；
 * - 钩子失败不阻塞执行，且由 HookRunner 统一落审计；
 * - 会话级事件的锚点是 session-<id>，与执行期的 rootGoalId 流并存。
 */

export interface SessionLifecycleDeps {
    bus: DefaultEventBus;
    hooks: HookRunner;
    /** rootGoalId → conversationId；由宿主持有（事件总线的 sessionOf 也读它）。 */
    sessionIds: Map<string, string>;
}

export interface TurnStartInput {
    rootGoalId: string;
    goalId: string;
    sessionId?: string;
    statement: string;
    route: string;
}

export interface TurnOutcome {
    result?: GoalRunResult;
    error?: unknown;
}

export class SessionLifecycle {
    private readonly live = new Set<string>();
    private readonly closed = new Set<string>();

    constructor(private readonly deps: SessionLifecycleDeps) {}

    sessionOf(rootGoalId: string): string | undefined {
        return this.deps.sessionIds.get(rootGoalId);
    }

    /** 会话开始：进程内幂等；session.started 先落盘，再跑 session.start 钩子。 */
    async begin(sessionId: string): Promise<void> {
        if (this.live.has(sessionId) || this.closed.has(sessionId)) return;
        this.live.add(sessionId);
        const anchor = sessionStreamId(sessionId);
        this.deps.bus.emit(
            newHarnessEvent({
                type: 'session.started',
                rootGoalId: anchor,
                sessionId,
                payload: {},
            }),
        );
        await this.deps.bus.flush();
        await this.deps.hooks.invoke('session.start', {
            hookPoint: 'session.start',
            sessionId,
            rootGoalId: anchor,
            payload: {},
        });
    }

    /**
     * 会话结束：先跑 session.end（异步副作用点），无论钩子是否失败都落 session.ended。
     * 释放该会话的 rootGoal 归因，避免长进程持续增长。
     */
    async end(sessionId: string, reason = 'session-ended'): Promise<void> {
        if (this.closed.has(sessionId)) return;
        this.closed.add(sessionId);
        const anchor = sessionStreamId(sessionId);
        try {
            await this.deps.hooks.invoke('session.end', {
                hookPoint: 'session.end',
                sessionId,
                rootGoalId: anchor,
                payload: { reason },
            });
        } finally {
            this.deps.bus.emit(
                newHarnessEvent({
                    type: 'session.ended',
                    rootGoalId: anchor,
                    sessionId,
                    payload: { reason },
                }),
            );
            await this.deps.bus.flush();
            this.live.delete(sessionId);
            for (const [rootGoalId, conversationId] of this.deps.sessionIds) {
                if (conversationId === sessionId) this.deps.sessionIds.delete(rootGoalId);
            }
        }
    }

    /**
     * 轮次开始：跑 turn.start 钩子并落 turn.started 事实。
     * 返回钩子注入的 contextAppend（无 patch 时 undefined），由调用方拼进系统提示。
     */
    async startTurn(input: TurnStartInput): Promise<string | undefined> {
        const { rootGoalId, goalId, sessionId } = input;
        const payload = { statement: input.statement, route: input.route };
        const decision = await this.deps.hooks.invoke('turn.start', {
            hookPoint: 'turn.start',
            rootGoalId,
            goalId,
            ...(sessionId !== undefined ? { sessionId } : {}),
            payload,
        });
        this.deps.bus.emit(
            newHarnessEvent({
                type: 'turn.started',
                rootGoalId,
                goalId,
                ...(sessionId !== undefined ? { sessionId } : {}),
                payload,
            }),
        );
        if (decision.decision.kind !== 'patch') return undefined;
        const append = decision.decision.patch.contextAppend;
        return typeof append === 'string' && append.trim().length > 0 ? append : undefined;
    }

    /** 轮次收尾：turn.end 钩子 + turn.ended 事实（成功/失败都发）。 */
    async endTurn(rootGoalId: string, outcome: TurnOutcome = {}): Promise<void> {
        const sessionId = this.deps.sessionIds.get(rootGoalId);
        const { result, error } = outcome;
        const payload = {
            ok: error === undefined && result?.ok === true,
            tasks: result?.tasks.length ?? 0,
            ...(error !== undefined
                ? { error: error instanceof Error ? error.message : String(error) }
                : {}),
            ...(result?.finalAnswer !== undefined && result.finalAnswer.length > 0
                ? { finalAnswer: result.finalAnswer.slice(0, 400) }
                : {}),
        };
        try {
            await this.deps.hooks.invoke('turn.end', {
                hookPoint: 'turn.end',
                rootGoalId,
                ...(sessionId !== undefined ? { sessionId } : {}),
                payload,
            });
        } finally {
            this.deps.bus.emit(
                newHarnessEvent({
                    type: 'turn.ended',
                    rootGoalId,
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    payload,
                }),
            );
            await this.deps.bus.flush();
        }
    }
}
