import type { EvalObservation, EvalTask, FailureCategory } from './types.js';

/**
 * Conservative failure attribution. Explicit executor evidence wins; generic
 * software rules are used only when there is a direct observable signal.
 */
export function attributeFailure(
    task: EvalTask,
    observation: EvalObservation,
): { category?: FailureCategory; evidence: string[] } {
    if (observation.ok) return { evidence: [] };
    if (observation.failureCategory !== undefined) {
        return {
            category: observation.failureCategory,
            evidence: [...(observation.failureEvidence ?? [])],
        };
    }
    if (observation.toolCalls.some((call) => !call.ok)) {
        return {
            category: 'tool_execution',
            evidence: ['至少一个工具调用返回失败'],
        };
    }
    const called = new Set(observation.toolCalls.map((call) => call.toolName));
    const missing = (task.expectedTools ?? []).filter((tool) => !called.has(tool));
    if (missing.length > 0) {
        return {
            category: 'tool_selection',
            evidence: [`缺少预期工具调用：${missing.join(', ')}`],
        };
    }
    if (observation.acceptance.evaluated === 0) {
        return {
            category: 'model',
            evidence: ['任务失败且没有任何可执行验收条款被判定'],
        };
    }
    return {
        category: 'planning',
        evidence: ['验收未通过，但未观察到工具执行失败或工具选择缺失'],
    };
}
