import type { TraceIdentifiers } from '@mazi/core';
import type { ToolCallResult } from '../config.js';
import { backoffDelay, type FaultPipeline, toFault, toFaultFromResult } from '../faults/index.js';
import type { Fault, FaultRecovery } from '../faults/types.js';
import type { GoalToolInvoker } from '../gts/goal-executor.js';
import type { HookRunner } from '../hooks/index.js';

/** 网关端口：只要能被调用即可，便于测试与后续替换实现。 */
export interface ToolGatewayPort {
    invoke(
        toolName: string,
        args: Record<string, unknown>,
        ctx: { stepId?: string; signal?: AbortSignal },
    ): Promise<ToolCallResult>;
}

/**
 * ToolInvoker —— 工具调用的唯一入口（设计 docs/runtime/AHF_RUNTIME_FAULTS.md §8）。
 *
 * 职责：tool.pre/工具执行/tool.post 三段成环；超时预算 + 异常收敛；
 * 失败交给 FaultPipeline 决策，并按结论重试或产出观察。
 * 对外契约：**永不抛**——任何异常都变成一条带分类的失败结果。
 */

/** 有副作用的工具：超时不得盲目重试（重试等于重复执行）。 */
const SIDE_EFFECT_TOOL_PATTERN = /^(shell\.run|fs\.write|fs\.edit|fs\.append|git|delegate)$/;

export function isIdempotentTool(toolName: string): boolean {
    return !SIDE_EFFECT_TOOL_PATTERN.test(toolName);
}

export interface ToolInvokerOptions {
    /** 本轮坐标（构造时固定，与 goalExecutionConfig 一一对应）。 */
    rootGoalId: string;
    goalId: string;
    sessionId?: string;
    gateway: ToolGatewayPort;
    hooks: HookRunner;
    faults: FaultPipeline;
    /** 单次工具执行超时预算（毫秒），缺省 120000。 */
    timeoutMs?: number;
    /** 同一调用的本地重试硬上限（防御性，正常由策略表约束）。 */
    maxLocalAttempts?: number;
}

export interface ToolInvokeOutcome {
    ok: boolean;
    content: string;
    error?: string;
    code?: string;
    retryable?: boolean;
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LOCAL_ATTEMPTS = 4;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 尝试计数键：同参必须同键（跨轮次共享，用于识别重复调用）。 */
export function toolCallKey(toolName: string, args: Record<string, unknown>): string {
    return `tool:${toolName}:${stableStringify(args)}`;
}

/** 键序稳定的 JSON（同参不同键序必须得到同一个键）。 */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export class ToolInvoker implements GoalToolInvoker {
    private readonly opts: ToolInvokerOptions;

    constructor(opts: ToolInvokerOptions) {
        this.opts = opts;
    }

    async invoke(
        toolName: string,
        args: Record<string, unknown>,
        ctx: { stepId?: string; taskId?: string } = {},
    ): Promise<ToolInvokeOutcome> {
        const trace = this.trace(ctx);
        const key = toolCallKey(toolName, args);
        const idempotent = isIdempotentTool(toolName);
        const pre = await this.runPreHook(toolName, args, trace);
        if (pre.kind === 'blocked') return pre.outcome;

        const effectiveArgs = pre.arguments;
        const maxAttempts = this.opts.maxLocalAttempts ?? DEFAULT_MAX_LOCAL_ATTEMPTS;
        let last: { fault: Fault; recovery: FaultRecovery } | undefined;

        for (let local = 1; local <= maxAttempts; local += 1) {
            const outcome = await this.runOnce(
                toolName,
                effectiveArgs,
                ctx,
                key,
                idempotent,
                trace,
            );
            if (outcome.ok) {
                // 此前失败过、这次成功：清零计数并广播 fault.recovered。
                this.opts.faults.recover(key, last?.fault);
                return this.runPostHook(toolName, effectiveArgs, outcome.content, trace);
            }
            const fault = outcome.fault;
            const recovery = this.opts.faults.decide(fault);
            last = { fault, recovery };
            if (recovery.action !== 'retry') break;
            await backoffDelay(recovery.delayMs);
        }

        if (last === undefined) {
            // 理论不可达：循环至少执行一次。
            return {
                ok: false,
                content: '',
                error: 'internal: 工具调用未产生结果',
                retryable: false,
            };
        }
        return {
            ok: false,
            content: '',
            error: describeFailure(last.fault, last.recovery),
            ...(last.fault.code !== undefined ? { code: last.fault.code } : {}),
            retryable: last.recovery.action === 'retry' || last.recovery.action === 'retry_altered',
        };
    }

    private trace(ctx: { stepId?: string; taskId?: string }): TraceIdentifiers {
        return {
            rootGoalId: this.opts.rootGoalId,
            goalId: this.opts.goalId,
            ...(this.opts.sessionId !== undefined ? { sessionId: this.opts.sessionId } : {}),
            ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
            ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
        };
    }

    private async runPreHook(
        toolName: string,
        args: Record<string, unknown>,
        trace: TraceIdentifiers,
    ): Promise<
        | { kind: 'ready'; arguments: Record<string, unknown> }
        | { kind: 'blocked'; outcome: ToolInvokeOutcome }
    > {
        const pre = await this.opts.hooks.invoke('tool.pre', {
            ...trace,
            hookPoint: 'tool.pre',
            payload: { toolName, arguments: args },
        });
        if (pre.decision.kind === 'block') {
            return {
                kind: 'blocked',
                outcome: {
                    ok: false,
                    content: '',
                    error: `HOOK_BLOCKED: hook 拦截 ${toolName}：${pre.decision.reason}`,
                    code: 'HOOK_BLOCKED',
                    retryable: false,
                },
            };
        }
        const patched = pre.decision.kind === 'patch' ? pre.decision.patch.arguments : undefined;
        return { kind: 'ready', arguments: isPlainRecord(patched) ? patched : args };
    }

    private async runPostHook(
        toolName: string,
        args: Record<string, unknown>,
        content: string,
        trace: TraceIdentifiers,
    ): Promise<ToolInvokeOutcome> {
        const post = await this.opts.hooks.invoke('tool.post', {
            ...trace,
            hookPoint: 'tool.post',
            payload: { toolName, arguments: args, ok: true, content: content.slice(0, 4000) },
        });
        const rewritten =
            post.decision.kind === 'patch' && typeof post.decision.patch.content === 'string'
                ? post.decision.patch.content
                : undefined;
        return { ok: true, content: rewritten ?? content };
    }

    /** 单次执行：超时预算内调用网关；抛出与超时都收敛成 Fault。 */
    private async runOnce(
        toolName: string,
        args: Record<string, unknown>,
        ctx: { stepId?: string; taskId?: string },
        key: string,
        idempotent: boolean,
        trace: TraceIdentifiers,
    ): Promise<{ ok: true; content: string } | { ok: false; fault: Fault }> {
        const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const result = await this.opts.gateway.invoke(toolName, args, {
                ...(ctx.stepId !== undefined ? { stepId: ctx.stepId } : {}),
                signal: controller.signal,
            });
            if (result.ok) {
                return { ok: true, content: String(result.content ?? '') };
            }
            // 信号已中止的失败一律归为超时：真实网关可能把中止回成普通失败。
            if (controller.signal.aborted) {
                return {
                    ok: false,
                    fault: toFault(new Error('tool timeout'), {
                        domain: 'tool',
                        key,
                        idempotent,
                        identifiers: trace,
                        code: 'TIMEOUT',
                        message: `工具执行超时（${timeoutMs}ms）`,
                    }),
                };
            }
            return {
                ok: false,
                fault: toFaultFromResult(
                    {
                        error: result.error ?? 'tool failed',
                        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
                    },
                    { domain: 'tool', key, idempotent, identifiers: trace },
                ),
            };
        } catch (error) {
            const timedOut = controller.signal.aborted;
            return {
                ok: false,
                fault: toFault(error, {
                    domain: 'tool',
                    key,
                    idempotent,
                    identifiers: trace,
                    ...(timedOut
                        ? { code: 'TIMEOUT', message: `工具执行超时（${timeoutMs}ms）` }
                        : { code: 'EXECUTION_FAILED' }),
                }),
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

/** 失败观察：模型可读，含处置建议与已尝试次数。 */
export function describeFailure(fault: Fault, recovery: FaultRecovery): string {
    const code = fault.code !== undefined ? `${fault.code}` : fault.kind;
    const attempts =
        recovery.attempt > 1
            ? `，已尝试 ${recovery.attempt} 次（${recovery.reason}）`
            : recovery.reason === 'non-idempotent'
              ? '；该工具非幂等，未自动重试'
              : '';
    const hint = fault.hint !== undefined ? `；建议：${fault.hint}` : '';
    const fix = fault.fix?.missing?.length ? `；缺少参数：${fault.fix.missing.join(', ')}` : '';
    return `${code}: ${fault.message}${attempts}${fix}${hint}`;
}
