import { defaultSeverityOf, type FaultSeverity } from './types.js';

/**
 * 错误层基础校验：策略表形状与严重度派生。
 * 处置逻辑在 `runtime/faults/pipeline.ts`，归一化在 `normalize.ts`。
 */

export { defaultSeverityOf };

/** 仅 `fatal` 允许直接中止；其余必须经策略表得出动作。 */
export function isFatalSeverity(severity: FaultSeverity): boolean {
    return severity === 'fatal';
}

/** 厂商/网关错误码 → 处置 kind（归一化的最后一跳）。code 表由本层维护，kind 不必闭集。 */
export const CODE_TO_KIND: Readonly<Record<string, string>> = {
    INVALID_ARGS: 'invalid_args',
    FORBIDDEN_UNREGISTERED: 'policy_denied',
    FORBIDDEN_BY_POLICY: 'policy_denied',
    NEEDS_APPROVAL: 'policy_denied',
    APPROVAL_REJECTED: 'policy_denied',
    SECRET_UNAVAILABLE: 'policy_denied',
    BUDGET_EXHAUSTED: 'budget_exhausted',
    EXECUTION_FAILED: 'internal',
    ENOENT: 'not_found',
    TIMEOUT: 'timeout',
    ECONNRESET: 'transient',
    ETIMEDOUT: 'timeout',
};

export function kindFromCode(code: string | undefined): string | undefined {
    if (code === undefined) return undefined;
    return CODE_TO_KIND[code];
}
