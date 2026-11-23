import {
    defaultSeverityOf,
    type Fault,
    type FaultDomain,
    type FaultFix,
    type FaultKind,
    type FaultScope,
    type FaultSeverity,
    type TraceIdentifiers,
    ulid,
} from '@mazi/core';
import { kindFromCode } from './policy.js';

/**
 * 归一化：任何 throw / 结果码 → Fault。
 * 生产者只提供"性质"，severity 缺省由 kind 派生；domain 决定 fatal 白名单的适用。
 */

export interface FaultContext {
    domain: FaultDomain;
    scope?: FaultScope;
    /** 尝试计数键：同参调用必须一致。 */
    key?: string;
    code?: string;
    idempotent?: boolean;
    retryable?: boolean;
    severity?: FaultSeverity;
    message?: string;
    hint?: string;
    fix?: FaultFix;
    identifiers?: TraceIdentifiers;
    cause?: unknown;
}

/** 运行时缺陷类错误名（编程缺陷，交 fatal 白名单判定）。 */
const DEFECT_ERROR_NAMES = new Set(['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);

function errorName(error: unknown): string {
    if (error instanceof Error) return error.name;
    return 'Unknown';
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return String(error ?? 'unknown failure');
}

/**
 * 抛出 → Fault。编程缺陷仅在非 tool 域升级为 fatal；
 * 工具实现抛错属于 `internal`（可降级），不得因工具抖动中止整棵树。
 */
export function toFault(error: unknown, ctx: FaultContext): Fault {
    const code = ctx.code;
    const kind: FaultKind = kindFromCode(code) ?? 'internal';
    const defect = ctx.domain !== 'tool' && DEFECT_ERROR_NAMES.has(errorName(error));
    const severity: FaultSeverity = ctx.severity ?? (defect ? 'fatal' : defaultSeverityOf(kind));
    const message = ctx.message ?? errorMessage(error);
    return {
        faultId: ulid(),
        domain: ctx.domain,
        kind,
        severity,
        scope: ctx.scope ?? 'call',
        retryable: ctx.retryable ?? (kind === 'timeout' || kind === 'transient'),
        ...(ctx.idempotent !== undefined ? { idempotent: ctx.idempotent } : {}),
        ...(ctx.key !== undefined ? { key: ctx.key } : {}),
        ...(code !== undefined ? { code } : {}),
        message,
        ...(ctx.hint !== undefined ? { hint: ctx.hint } : {}),
        ...(ctx.fix !== undefined ? { fix: ctx.fix } : {}),
        ...(ctx.identifiers !== undefined ? { identifiers: ctx.identifiers } : {}),
        ...(ctx.cause !== undefined ? { cause: error ?? ctx.cause } : {}),
    };
}

/**
 * 网关/工具的结构化失败 → Fault。
 * `error` 形如 `INVALID_ARGS: 缺少必填参数：path` 时拆出 code；否则按 internal 处理。
 */
export function toFaultFromResult(
    failure: { error?: string; code?: string; retryable?: boolean; hint?: string; fix?: FaultFix },
    ctx: Omit<FaultContext, 'cause'>,
): Fault {
    const raw = failure.error ?? failure.hint ?? 'tool failed';
    const parsed = parseCode(raw);
    const code = failure.code ?? parsed.code;
    const kind = kindFromCode(code) ?? 'internal';
    return {
        faultId: ulid(),
        domain: ctx.domain,
        kind,
        severity: ctx.severity ?? defaultSeverityOf(kind),
        scope: ctx.scope ?? 'call',
        retryable: failure.retryable ?? (kind === 'timeout' || kind === 'transient'),
        ...(ctx.idempotent !== undefined ? { idempotent: ctx.idempotent } : {}),
        ...(ctx.key !== undefined ? { key: ctx.key } : {}),
        ...(code !== undefined ? { code } : {}),
        message: parsed.message,
        ...(failure.hint !== undefined ? { hint: failure.hint } : {}),
        ...(failure.fix !== undefined ? { fix: failure.fix } : {}),
        ...(ctx.identifiers !== undefined ? { identifiers: ctx.identifiers } : {}),
    };
}

/** `CODE: message` → { code, message }；无前缀时 message 原样返回。 */
export function parseCode(raw: string): { code?: string; message: string } {
    const match = /^([A-Z][A-Z0-9_]{2,}):\s*(.*)$/.exec(raw);
    if (match === null) return { message: raw };
    return { code: match[1], message: match[2] ?? raw };
}
