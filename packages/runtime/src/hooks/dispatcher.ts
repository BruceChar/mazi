import type {
    HookContext,
    HookDecision,
    HookDispatchMode,
    HookHandlerFailure,
    HookInvocationResult,
    HookPoint,
    HookRegistration,
    Unsubscribe,
} from '@mazi/core';

/**
 * HookDispatcher —— 单点的多监听器派发（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §4.2）。
 *
 * 只做派发与聚合，不发事件、不碰权限：审计由 HookRunner 负责。
 * 设计上区分两种结果：
 * - block：决策性拦截（只在 pre 类点生效，post 类点降级为 continue）
 * - patch：白名单字段的改写，按注册顺序浅合并（后者覆盖前者）
 */

/** pre 类点：允许 block 拦截。post/end 类点上的 block 会被降级并记审计。 */
const BLOCKABLE_POINTS: ReadonlySet<HookPoint> = new Set<HookPoint>([
    'session.start',
    'turn.start',
    'context.assemble',
    'compaction.pre',
    'tool.pre',
    'llm.pre',
]);

export class HookTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HookTimeoutError';
    }
}

interface HandlerOutcome {
    decision?: HookDecision;
    failure?: HookHandlerFailure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 handler 输出；非法形状按失败处理，避免畸形 patch 污染主循环。 */
function normalizeOutput(id: string, output: unknown): HandlerOutcome {
    if (output === undefined || output === null) return { decision: { kind: 'continue' } };
    if (!isRecord(output)) {
        return {
            failure: { id, mode: 'error', message: 'hook 返回值必须是 HookDecision 或空' },
        };
    }
    if (output.kind === 'continue') return { decision: { kind: 'continue' } };
    if (output.kind === 'block') {
        if (typeof output.reason !== 'string' || output.reason.trim().length === 0) {
            return {
                failure: { id, mode: 'error', message: 'block 决策必须携带非空 reason' },
            };
        }
        return { decision: { kind: 'block', reason: output.reason } };
    }
    if (output.kind === 'patch') {
        if (!isRecord(output.patch)) {
            return {
                failure: { id, mode: 'error', message: 'patch 决策必须携带对象 patch' },
            };
        }
        return {
            decision: {
                kind: 'patch',
                patch: output.patch,
                ...(typeof output.reason === 'string' ? { reason: output.reason } : {}),
            },
        };
    }
    return {
        failure: { id, mode: 'error', message: `未知 hook 决策 kind=${String(output.kind)}` },
    };
}

/** 带超时的单 handler 执行；超时通过 AbortSignal 通知 handler 自行收尾。 */
async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T> | T,
    timeoutMs: number,
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new HookTimeoutError(`hook 超时（${timeoutMs}ms）`));
        }, Math.max(1, timeoutMs));
    });
    try {
        return await Promise.race([Promise.resolve(run(controller.signal)), guard]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function mergePatch(
    target: Record<string, unknown>,
    patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    return { ...target, ...patch };
}

function composeDecision(
    point: HookPoint,
    block: { reason: string } | undefined,
    patch: Record<string, unknown>,
): HookDecision {
    const patched = Object.keys(patch).length > 0;
    if (block !== undefined) {
        if (BLOCKABLE_POINTS.has(point)) {
            return { kind: 'block', reason: block.reason };
        }
        // post/end 类点不允许拦截：降级为改写（若有）或继续，并保留原因供审计。
        return patched
            ? { kind: 'patch', patch, reason: `block 已降级：${block.reason}` }
            : { kind: 'continue' };
    }
    return patched ? { kind: 'patch', patch } : { kind: 'continue' };
}

export interface HookDispatcherOptions {
    /** 可注入时钟（测试用）。 */
    now?: () => number;
    /** 未指定 timeoutMs 时的兜底值。 */
    defaultTimeoutMs?: number;
}

export class HookDispatcher {
    private readonly registrations = new Map<HookPoint, HookRegistration[]>();
    private readonly now: () => number;
    private readonly defaultTimeoutMs: number;

    constructor(options: HookDispatcherOptions = {}) {
        this.now = options.now ?? Date.now;
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2000;
    }

    register(registration: HookRegistration): Unsubscribe {
        const list = this.registrations.get(registration.point) ?? [];
        if (list.some((item) => item.id === registration.id)) {
            throw new Error(`hook id 重复注册：${registration.id} @ ${registration.point}`);
        }
        list.push(registration);
        this.registrations.set(registration.point, list);
        return () => {
            const current = this.registrations.get(registration.point);
            if (current === undefined) return;
            const next = current.filter((item) => item !== registration);
            if (next.length === 0) this.registrations.delete(registration.point);
            else this.registrations.set(registration.point, next);
        };
    }

    listenerCount(point: HookPoint): number {
        return this.registrations.get(point)?.length ?? 0;
    }

    /** 按 priority 升序；同优先级保持注册顺序（依赖 Array#sort 的稳定性）。 */
    private ordered(point: HookPoint): readonly HookRegistration[] {
        const list = this.registrations.get(point);
        if (list === undefined || list.length === 0) return [];
        return list.slice().sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    }

    async invoke(
        point: HookPoint,
        ctx: HookContext,
        mode: HookDispatchMode,
    ): Promise<HookInvocationResult> {
        const started = this.now();
        const handlers = this.ordered(point);
        if (handlers.length === 0) {
            return {
                point,
                mode,
                decision: { kind: 'continue' },
                applied: [],
                failures: [],
                elapsedMs: 0,
            };
        }

        const applied: string[] = [];
        const failures: HookHandlerFailure[] = [];
        let block: { reason: string } | undefined;
        let patch: Record<string, unknown> = {};
        let accumulated: Record<string, unknown> | undefined;

        const execute = async (
            registration: HookRegistration,
            input: HookContext,
        ): Promise<HandlerOutcome> => {
            const timeoutMs = registration.timeoutMs ?? this.defaultTimeoutMs;
            try {
                const output = await withTimeout(
                    (signal) => registration.handle({ ...input, signal }),
                    timeoutMs,
                );
                return normalizeOutput(registration.id, output);
            } catch (error) {
                const timeout = error instanceof HookTimeoutError;
                const message = timeout
                    ? `hook 超时（${timeoutMs}ms）`
                    : error instanceof Error
                      ? error.message
                      : String(error);
                if (registration.onError === 'fail' && BLOCKABLE_POINTS.has(point)) {
                    // fail-closed：handler 自身故障时，pre 点按拒绝处理。
                    return {
                        decision: {
                            kind: 'block',
                            reason: `hook ${registration.id} fail-closed：${message}`,
                        },
                        failure: { id: registration.id, mode: timeout ? 'timeout' : 'error', message },
                    };
                }
                return {
                    failure: { id: registration.id, mode: timeout ? 'timeout' : 'error', message },
                };
            }
        };

        const absorb = (outcome: HandlerOutcome): void => {
            if (outcome.decision?.kind === 'block' && block === undefined) {
                block = { reason: outcome.decision.reason };
            }
            if (outcome.decision?.kind === 'patch') {
                patch = mergePatch(patch, outcome.decision.patch);
            }
            if (outcome.failure !== undefined) failures.push(outcome.failure);
        };

        if (mode === 'emit') {
            // 纯广播：同步触发、不等待、不收集决策（异步拒绝只记失败）。
            for (const registration of handlers) {
                applied.push(registration.id);
                try {
                    const output = registration.handle({ ...ctx });
                    void Promise.resolve(output).catch((error: unknown) => {
                        failures.push({
                            id: registration.id,
                            mode: 'error',
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
                } catch (error) {
                    failures.push({
                        id: registration.id,
                        mode: 'error',
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        } else if (mode === 'parallel') {
            const outcomes = await Promise.all(
                handlers.map(async (registration) => {
                    applied.push(registration.id);
                    return { registration, outcome: await execute(registration, ctx) };
                }),
            );
            for (const { outcome } of outcomes) absorb(outcome);
        } else if (mode === 'waterfall') {
            for (const registration of handlers) {
                applied.push(registration.id);
                const outcome = await execute(registration, { ...ctx, accumulated });
                absorb(outcome);
                if (outcome.decision?.kind === 'patch') {
                    accumulated = mergePatch(accumulated ?? {}, outcome.decision.patch);
                }
                if (block !== undefined && BLOCKABLE_POINTS.has(point)) break;
            }
        } else if (mode === 'bail') {
            for (const registration of handlers) {
                applied.push(registration.id);
                const outcome = await execute(registration, ctx);
                absorb(outcome);
                if (block !== undefined) break;
            }
        } else {
            // serial
            for (const registration of handlers) {
                applied.push(registration.id);
                absorb(await execute(registration, ctx));
            }
        }

        return {
            point,
            mode,
            decision: composeDecision(point, block, patch),
            applied,
            failures,
            elapsedMs: this.now() - started,
        };
    }
}
