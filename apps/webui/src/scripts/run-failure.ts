/**
 * Trace 面板的运行失败摘要：合并 Goal 终态事件、失败分类账、Replan 拒绝与
 * Task 验收事实，生成稳定、可去重的展示行。纯函数，便于回放和单测。
 */

import type { EventItem, FailureLedgerView } from '../types.ts';
import type { ContractTraceView } from './contract-view.ts';

export interface RunFailureView {
    status: 'failed' | 'aborted' | 'warning';
    summary: string;
    causes: string[];
    warnings: string[];
}

export interface RunFailureInput {
    rootGoalId?: string | null;
    events?: readonly EventItem[] | null;
    failures?: readonly FailureLedgerView[] | null;
    contracts?: readonly ContractTraceView[] | null;
}

function textOf(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function listOf(value: unknown): string[] {
    return Array.isArray(value) ? value.map(textOf).filter((item) => item.length > 0) : [];
}

function eventBelongsToRun(event: EventItem, rootGoalId: string): boolean {
    return !rootGoalId || !event.rootGoalId || event.rootGoalId === rootGoalId;
}

function unique(items: readonly string[]): string[] {
    return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

export function buildRunFailureView(input: RunFailureInput): RunFailureView | null {
    const rootGoalId = textOf(input.rootGoalId);
    const eventList = Array.isArray(input.events) ? input.events : [];
    const events = eventList.filter((event) => eventBelongsToRun(event, rootGoalId));
    const terminal = [...events]
        .reverse()
        .find((event) => event.type === 'goal.ended' || event.type === 'run.aborted');
    const terminalPayload = (terminal?.payload ?? {}) as {
        outcome?: { status?: unknown; summary?: unknown };
        error?: unknown;
    };
    const terminalStatus = textOf(terminalPayload.outcome?.status);
    const terminalSummary = textOf(terminalPayload.outcome?.summary);
    const terminalError = textOf(terminalPayload.error);
    const terminalFailed =
        terminal?.type === 'run.aborted' ||
        terminalStatus === 'failed' ||
        terminalStatus === 'aborted';

    const replanRejected = events.flatMap((event) => {
        if (event.type !== 'replan.rejected') return [];
        const payload = event.payload as { rejected?: unknown } | undefined;
        return listOf(payload?.rejected);
    });
    const warnings = events.flatMap((event) => {
        if (event.type !== 'plan.revised') return [];
        const payload = event.payload as { warnings?: unknown } | undefined;
        return listOf(payload?.warnings);
    });

    const failures = (input.failures ?? []).filter(
        (failure) => !rootGoalId || failure.sessionId === rootGoalId,
    );
    const ledgerCauses = failures.map((failure) => {
        const prefix = [failure.kind, failure.category].filter(Boolean).join(' · ');
        const summary = textOf(failure.summary);
        return prefix && summary ? `${prefix} · ${summary}` : prefix || summary;
    });
    const ledgerTaskIds = new Set(
        failures.flatMap((failure) => (failure.taskId ? [failure.taskId] : [])),
    );
    const taskCauses = (input.contracts ?? [])
        .filter(
            (contract) => !rootGoalId || !contract.rootGoalId || contract.rootGoalId === rootGoalId,
        )
        .flatMap((contract) => contract.tasks)
        .flatMap((task) => {
            if (ledgerTaskIds.has(task.taskId)) return [];
            const details =
                task.result?.conditions
                    .filter((condition) => condition.status === 'failed')
                    .map((condition) => textOf(condition.detail)) ?? [];
            const isFailure = ['failed', 'blocked', 'timeout'].includes(task.status);
            if (!isFailure && details.length === 0) return [];
            return details.length > 0
                ? details.map((detail) => `${task.title}：${detail}`)
                : [`${task.title}：${task.status}`];
        });

    const causes = unique([
        ...(terminalFailed ? [terminalSummary, terminalError] : []),
        ...replanRejected,
        ...ledgerCauses,
        ...taskCauses,
    ]);
    const warningList = unique(warnings);
    const status =
        terminal?.type === 'run.aborted' || terminalStatus === 'aborted'
            ? 'aborted'
            : terminalStatus === 'failed' || causes.length > 0 || failures.length > 0
              ? 'failed'
              : warningList.length > 0
                ? 'warning'
                : null;
    if (status === null) return null;

    return {
        status,
        summary: causes[0] ?? (status === 'warning' ? '计划已自动修正，运行继续' : '运行失败'),
        causes,
        warnings: warningList,
    };
}
