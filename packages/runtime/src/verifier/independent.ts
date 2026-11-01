import type { ConditionResult, Goal } from '@mazi/core';
import { evaluateAcceptance } from '../gts/acceptance.js';
import type { TaskOutcome } from '../gts/goal-executor.js';
import type {
    SemanticJudge,
    TaskVerifier,
    VerificationFailureCategory,
    VerificationReport,
} from './types.js';

function evidenceOf(outcome: TaskOutcome): string[] {
    const evidence: string[] = [];
    if (outcome.finalMessage !== undefined) {
        evidence.push(`final:${outcome.finalMessage.slice(0, 1000)}`);
    }
    for (const step of outcome.steps.slice(-10)) {
        if (step.kind === 'invocation') {
            evidence.push(
                `tool:${step.payload.toolName}:${step.status}:${(step.payload.output ?? '').slice(0, 500)}`,
            );
        } else if (step.payload.answer !== undefined) {
            evidence.push(`answer:${step.payload.answer.slice(0, 500)}`);
        }
    }
    if (outcome.errorMessage !== undefined) evidence.push(`error:${outcome.errorMessage}`);
    return evidence;
}

function failureCategoryOf(outcome: TaskOutcome): VerificationFailureCategory | undefined {
    if (outcome.ok) return undefined;
    const stepErrors = outcome.steps
        .map((step) => step.error)
        .filter((error): error is NonNullable<typeof error> => error !== undefined);
    if (stepErrors.some((error) => error.source === 'policy')) return 'policy';
    if (stepErrors.some((error) => error.source === 'tool')) return 'tool_execution';
    if (stepErrors.some((error) => error.source === 'context')) return 'context';
    if (outcome.reason === 'blocked-tool') return 'tool_execution';
    if (outcome.reason === 'max-steps') return 'planning';
    if (outcome.reason === 'driver-error') return 'model';
    if (outcome.reason === 'budget-exceeded') return 'planning';
    return 'system';
}

/**
 * Independent verifier. Deterministic checks are code; semantic checks require
 * an explicitly injected judge and remain uncertain when no calibrated judge is
 * available. The verifier never mutates the plan, tools or acceptance contract.
 */
export class IndependentVerifier implements TaskVerifier {
    readonly id = 'independent-default';
    private semanticJudge?: SemanticJudge;

    constructor(options: { semanticJudge?: SemanticJudge; now?: () => number } = {}) {
        this.semanticJudge = options.semanticJudge;
        this.now = options.now ?? Date.now;
    }

    private readonly now: () => number;

    setSemanticJudge(judge?: SemanticJudge): void {
        this.semanticJudge = judge;
    }

    get hasSemanticJudge(): boolean {
        return this.semanticJudge !== undefined;
    }

    async verify(goal: Goal, outcome: TaskOutcome): Promise<VerificationReport> {
        const mechanical = evaluateAcceptance(goal, outcome, this.now);
        const evidence = evidenceOf(outcome);
        const selected = new Set(
            outcome.task.acceptance.conditions.length > 0
                ? outcome.task.acceptance.conditions
                : goal.contract.successConditions.map((condition) => condition.id),
        );
        const conditions: ConditionResult[] = [];
        for (const condition of goal.contract.successConditions) {
            if (!selected.has(condition.id)) continue;
            const base = mechanical.conditions.find((item) => item.conditionId === condition.id);
            if (
                condition.checkType !== 'semantic' ||
                this.semanticJudge === undefined ||
                base?.status !== 'unchecked'
            ) {
                if (base !== undefined) conditions.push(base);
                continue;
            }
            try {
                const verdict = await this.semanticJudge.judge({
                    goal,
                    outcome,
                    conditionId: condition.id,
                    condition: condition.description ?? condition.id,
                    evidence,
                });
                conditions.push({
                    conditionId: condition.id,
                    status:
                        verdict.status === 'passed'
                            ? 'passed'
                            : verdict.status === 'failed'
                              ? 'failed'
                              : 'unchecked',
                    detail: [
                        `judge:${this.semanticJudge.id}`,
                        verdict.confidence !== undefined
                            ? `confidence=${verdict.confidence}`
                            : '',
                        verdict.reason ?? '',
                    ]
                        .filter((part) => part.length > 0)
                        .join(' '),
                });
            } catch (error) {
                conditions.push({
                    conditionId: condition.id,
                    status: 'unchecked',
                    detail: `judge-error:${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
        const evaluated = conditions.filter((item) => item.status !== 'unchecked').length;
        const failed = conditions.some((item) => item.status === 'failed');
        const passed =
            outcome.ok &&
            !failed &&
            conditions.every((item) => item.status === 'passed');
        const state = !outcome.ok || failed ? 'failed' : passed ? 'passed' : 'uncertain';
        const acceptance = {
            checkedAt: this.now(),
            passed: outcome.ok && !failed,
            evaluated,
            total: conditions.length,
            conditions,
        };
        return {
            verifierId: this.id,
            state,
            acceptance,
            ...(failureCategoryOf(outcome) !== undefined
                ? { failureCategory: failureCategoryOf(outcome) }
                : {}),
            evidence,
            ...(this.semanticJudge !== undefined
                ? { semanticJudgeId: this.semanticJudge.id }
                : {}),
            checkedAt: acceptance.checkedAt,
        };
    }
}
