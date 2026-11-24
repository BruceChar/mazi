import type { Goal, Step } from '@mazi/core';
import { ulid } from '@mazi/core';
import type { GoalStore } from '../memory/goal-store.js';
import type { TaskVerifier, VerificationReport } from '../verifier/types.js';
import { evaluateAcceptance } from './acceptance.js';
import type { TaskOutcome } from './task-execution.js';

/** 验收事实的最小投影；default loop 的纯规则验收也可复用。 */
export interface VerificationRecord {
    verifierId: string;
    state: VerificationReport['state'];
    acceptance: VerificationReport['acceptance'];
    evidence: readonly string[];
    failureCategory?: VerificationReport['failureCategory'];
}

function acceptanceSummary(record: VerificationRecord): string {
    const { acceptance } = record;
    const state =
        record.state === 'passed' ? '通过' : record.state === 'failed' ? '未通过' : '待判定';
    const scope =
        acceptance.total > 0
            ? `${acceptance.evaluated}/${acceptance.total} 项已检查`
            : '无机械条款';
    const evidence = record.evidence.length > 0 ? ` · 证据 ${record.evidence.length} 条` : '';
    const failure =
        record.failureCategory !== undefined ? ` · 失败分类 ${record.failureCategory}` : '';
    return `验收${state} · ${record.verifierId} · ${scope}${evidence}${failure}`;
}

/**
 * 契约层验收的唯一入口：判定 → 写 acceptanceResult → 留 verification 事件 → 落 verify Step。
 *
 * default loop 与 dynamic loop 只在“谁触发”上不同，判定与落账必须走同一段代码，
 * 避免两条路径各写一份验收逻辑而漂移。
 */
export async function verifyTaskOutcome(options: {
    goal: Goal;
    outcome: TaskOutcome;
    verifier?: TaskVerifier;
    store: GoalStore;
    onVerification?: (report: VerificationReport, outcome: TaskOutcome) => void;
    onStep?: (step: Step) => void;
    startedAt?: number;
}): Promise<VerificationReport | undefined> {
    const { goal, outcome, verifier, store, onVerification, onStep } = options;
    const startedAt = options.startedAt ?? Date.now();
    if (verifier !== undefined) {
        const report = await verifier.verify(goal, outcome);
        outcome.task.acceptanceResult = report.acceptance;
        onVerification?.(report, outcome);
        await recordVerificationStep({
            store,
            report,
            outcome,
            startedAt,
            ...(onStep !== undefined ? { onStep } : {}),
        });
        return report;
    }
    const acceptance = evaluateAcceptance(goal, outcome);
    outcome.task.acceptanceResult = acceptance;
    await recordVerificationStep({
        store,
        report: {
            verifierId: 'acceptance-rule',
            state: acceptance.passed ? 'passed' : 'failed',
            acceptance,
            evidence: [],
        },
        outcome,
        startedAt,
        ...(onStep !== undefined ? { onStep } : {}),
    });
    return undefined;
}

/**
 * 把验收结论落成一条 role=verify 的 Step。
 *
 * 契约层 Verifier 负责判定；这里只负责“判定发生过”的可审计事实，避免每个 loop
 * 各自吞掉报告。kind 仍为 observation（Step 持久化判别式只有三类），role/node 负责展示。
 */
export async function recordVerificationStep(options: {
    store: GoalStore;
    report: VerificationRecord;
    outcome: TaskOutcome;
    startedAt: number;
    onStep?: (step: Step) => void;
    now?: () => number;
}): Promise<Step> {
    const { store, report, outcome, startedAt, onStep, now = Date.now } = options;
    const summary = acceptanceSummary(report);
    const step: Step = {
        stepId: ulid(),
        taskId: outcome.task.taskId,
        goalId: outcome.task.goalId,
        role: 'verify',
        nodeRunId: `verify:${outcome.task.taskId}`,
        nodeId: 'verify',
        nodeRole: 'verify',
        agentRole: 'verifier',
        kind: 'observation',
        payload: {
            observations: [],
            disposition: 'final',
            result: summary,
        },
        status:
            report.state === 'failed' || report.acceptance.passed === false
                ? 'failed'
                : 'succeeded',
        startedAt,
        endedAt: now(),
    };
    outcome.steps.push(step);
    await store.saveStep(step);
    onStep?.(step);
    return step;
}
