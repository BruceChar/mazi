import type { AcceptanceSpec, ReflectionRequest, ReflectionVerdict, Reflector } from '@mazi/core';

/**
 * 机械验收：所有 success.conditions 均须满足。支持三类条件：
 * - 'contains:<sub>'：最终回答包含子串
 * - 'regex:<pattern>'：最终回答匹配正则
 * - 其他字符串：按子串匹配处理
 */
export function acceptanceMet(
    spec: AcceptanceSpec,
    outcomeOk: boolean,
    finalMessage?: string,
): boolean {
    if (!outcomeOk) {
        return false;
    }
    const message = finalMessage ?? '';
    for (const condition of spec.conditions) {
        if (condition.startsWith('contains:')) {
            if (!message.includes(condition.slice('contains:'.length))) {
                return false;
            }
        } else if (condition.startsWith('regex:')) {
            try {
                if (!new RegExp(condition.slice('regex:'.length)).test(message)) {
                    return false;
                }
            } catch {
                return false;
            }
        } else if (!message.includes(condition)) {
            return false;
        }
    }
    return true;
}

/** MVP 独立 Reflector：确定性机械验收，不做 LLM judge */
export class MechanicalReflector implements Reflector {
    async reflect(request: ReflectionRequest): Promise<ReflectionVerdict> {
        const message = request.finalMessage ?? '';
        const failedConditions = request.outcomeOk
            ? request.success.conditions.filter(
                  (condition) => !conditionSatisfied(condition, message),
              )
            : [...request.success.conditions];
        const matchedConditions = request.success.conditions.filter(
            (condition) => !failedConditions.includes(condition),
        );
        return {
            accepted: request.outcomeOk && failedConditions.length === 0,
            reason:
                failedConditions.length > 0
                    ? `未满足条件：${failedConditions.join('; ')}`
                    : undefined,
            matchedConditions,
            failedConditions,
        };
    }
}

function conditionSatisfied(condition: string, message: string): boolean {
    if (condition.startsWith('contains:')) {
        return message.includes(condition.slice('contains:'.length));
    }
    if (condition.startsWith('regex:')) {
        try {
            return new RegExp(condition.slice('regex:'.length)).test(message);
        } catch {
            return false;
        }
    }
    return message.includes(condition);
}
