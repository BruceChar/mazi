import { evaluateObservation } from './metrics.js';
import type {
    EvalExecutionContext,
    EvalObservation,
    EvalTask,
    EvalTaskExecutor,
    EvalTaskResult,
} from './types.js';

export class EvalTaskTimeoutError extends Error {
    constructor(
        readonly taskId: string,
        readonly timeoutMs: number,
    ) {
        super(`评测任务超时：${taskId} > ${timeoutMs}ms`);
        this.name = 'EvalTaskTimeoutError';
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, taskId: string): Promise<T> {
    if (timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new EvalTaskTimeoutError(taskId, timeoutMs)),
            timeoutMs,
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function failedObservation(task: EvalTask, error: unknown): EvalObservation {
    const message = error instanceof Error ? error.message : String(error);
    return {
        ok: false,
        acceptance: {
            checkedAt: Date.now(),
            passed: false,
            evaluated: 0,
            total: task.acceptance.length,
            conditions: task.acceptance.map((condition) => ({
                conditionId: condition.id,
                status: 'unchecked',
            })),
        },
        steps: 0,
        toolCalls: [],
        interventions: 0,
        replans: 0,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        failureCategory: error instanceof EvalTaskTimeoutError ? 'system' : 'environment',
        failureEvidence: [message],
        error: message,
    };
}

export async function runEvalTask(
    task: EvalTask,
    executor: EvalTaskExecutor,
    options: Omit<EvalExecutionContext, 'task'> & { timeoutMs?: number } = {},
): Promise<EvalTaskResult> {
    const started = Date.now();
    let observation: EvalObservation;
    try {
        observation = await withTimeout(
            executor({
                task,
                ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
                ...(options.promptPackId !== undefined
                    ? { promptPackId: options.promptPackId }
                    : {}),
                ...(options.permissionCeiling !== undefined
                    ? { permissionCeiling: options.permissionCeiling }
                    : {}),
            }),
            options.timeoutMs ?? 0,
            task.id,
        );
    } catch (error) {
        observation = failedObservation(task, error);
        observation.latencyMs = Date.now() - started;
    }
    return evaluateObservation(task, observation);
}

export async function runEvalSuite(
    tasks: readonly EvalTask[],
    executor: EvalTaskExecutor,
    options: Omit<EvalExecutionContext, 'task'> & { timeoutMs?: number } = {},
): Promise<EvalTaskResult[]> {
    const results: EvalTaskResult[] = [];
    for (const task of tasks) {
        results.push(await runEvalTask(task, executor, options));
    }
    return results;
}
