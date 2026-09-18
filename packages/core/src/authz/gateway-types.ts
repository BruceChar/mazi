/**
 * Execution gateway contract (V3 §8).
 *
 * The gateway consumes an immutable EffectivePolicy snapshot produced by
 * derive(); it never computes policy or widens it. Stages execute in
 * GATEWAY_PIPELINE_STAGES order and every stage emits an audit event.
 */

import type { AuditIdentifiers } from '../observability.js';
import type { ApprovalEcho } from './approval.js';
import type { CommandPolicy } from './command.js';
import type { AssetLabelRegistry } from './labels.js';
import type { DataflowLedger, TaintTable } from './ledger.js';
import type {
    Invocation,
    SecretPurpose,
    SecretRef,
    SecretService,
    SignedRequest,
} from './secret.js';
import type {
    AuthzErrorCode,
    Budget,
    CapabilitySpec,
    EffectivePolicy,
    Question,
    ToolSemantics,
    ValueProjection,
} from './types.js';

/** Tool parameter JSON Schema (bridges to @mazi/provider; core stays schema-agnostic). */
export type JSONSchemaSpec = Record<string, unknown>;

/** confined = sandboxable; full = outside sandbox control (clamped to gated). */
export type ToolTrust = 'confined' | 'full';

export type PendingHandle = string;

/** Value-layer projection declaration (registration states which args carry what). */
export interface ScopeProjection {
    pathParams?: string[];
    hostParams?: string[];
    amountParam?: string;
    commandParam?: string;
    sqlParam?: string;
}

export interface HandlerContext {
    signal: AbortSignal;
    /** Counter-signed requests keyed by refId; the handler never sees plaintext. */
    credentials?: ReadonlyMap<string, SignedRequest>;
}

export interface ToolOutput {
    value: unknown;
    untrusted?: boolean;
}

export type ToolHandler = (
    args: Record<string, unknown>,
    ctx: HandlerContext,
) => Promise<ToolOutput>;

/** Registry entry. Unregistered tools are forbidden (closed world). */
export interface ToolRegistration {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    /** Dispatch anchor into the effective policy. */
    capability: string;
    coCapabilities?: readonly string[];
    /** Three-question declaration for this tool. */
    semantics: ToolSemantics;
    scope: ScopeProjection;
    trust: ToolTrust;
    /** net.fetch / MCP-class: the returned value is tagged untrusted. */
    untrustedOutput?: boolean;
    /** Secret ref ids this tool may resolve; only in allowedSinks. */
    secrets?: readonly string[];
    /** Purpose bound to a severed secret read (mechanism 2 attribute proxy). */
    secretPurpose?: SecretPurpose;
    /** Structured invocation builder for gateway signing. */
    invocation?: (args: Record<string, unknown>) => Invocation;
    handler: ToolHandler;
}

/** Supply view exposed to the model (visibility narrowing, not a security boundary). */
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JSONSchemaSpec;
    capability: string;
    effectiveTier: 'auto' | 'gated';
    trust: ToolTrust;
    irreversible?: boolean;
}

export interface InvocationRequest {
    tool: string;
    args: Record<string, unknown>;
    /** Harness-injected attribution overrides (never model-supplied). */
    stepId?: string;
    taskId?: string;
}

/** 审批授权作用域：一次 / 本会话 / 本工作区。 */
export type ApprovalScope = 'once' | 'session' | 'workspace';

export type ApprovalDecision =
    | { decision: 'granted'; scope: ApprovalScope }
    | { decision: 'rejected'; reason: string }
    | { decision: 'cancelled' };

export interface ApprovalRequest {
    invocationId: string;
    tool: string;
    capability: string;
    echo: ApprovalEcho;
    /** 该调用允许的作用域；高危命令只有 once，UI 应隐藏其余按钮。 */
    allowedScopes: readonly ApprovalScope[];
    /** Harness-injected attribution so the UI can route the request. */
    identifiers: AuditIdentifiers;
}

/** Human-in-the-loop seam; absent → gated calls fail closed. */
export interface ApprovalSeam {
    decide(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * 一条被记住的审批：绑定到**具体操作**（tool + 命令/路径/host/参数指纹），
 * 而不是能力类目。批准 `ping baidu.com` 不会顺带批准 `netstat`。
 */
export interface SessionApproval {
    id: string;
    /** 操作指纹（approvalKeyOf 生成）。 */
    key: string;
    /** 归因：所属 capability（展示/审计用）。 */
    capability: string;
    scope: 'session' | 'workspace';
    /** session 作用域限定的会话 id；workspace 作用域忽略该字段。 */
    sessionId?: string;
    createdAt: number;
}

/**
 * Process-level approval store. The gateway is re-created per execution, so
 * session/workspace grants must live outside it or they are lost between runs.
 * 命中条件：同 key，且（workspace）或（session 且 sessionId 匹配）。
 */
export interface ApprovalStore {
    remember(approval: SessionApproval): void;
    has(key: string, sessionId?: string): boolean;
    list(): readonly SessionApproval[];
    /** 撤销某个操作的授权；缺省清空全部。返回删除条数。 */
    revoke(key?: string): number;
    /** 清理某个会话的 session 作用域授权；workspace 授权保留。 */
    clearSession(sessionId: string): number;
}

export class InMemoryApprovalStore implements ApprovalStore {
    private readonly records = new Map<string, SessionApproval>();

    private static recordId(approval: SessionApproval): string {
        return `${approval.scope}:${approval.sessionId ?? ''}:${approval.key}`;
    }

    remember(approval: SessionApproval): void {
        this.records.set(InMemoryApprovalStore.recordId(approval), approval);
    }

    has(key: string, sessionId?: string): boolean {
        for (const record of this.records.values()) {
            if (record.key !== key) continue;
            if (record.scope === 'workspace') return true;
            if (
                record.scope === 'session' &&
                sessionId !== undefined &&
                record.sessionId === sessionId
            ) {
                return true;
            }
        }
        return false;
    }

    list(): readonly SessionApproval[] {
        return [...this.records.values()];
    }

    revoke(key?: string): number {
        let removed = 0;
        for (const [id, record] of [...this.records]) {
            if (key === undefined || record.key === key) {
                this.records.delete(id);
                removed += 1;
            }
        }
        return removed;
    }

    clearSession(sessionId: string): number {
        let removed = 0;
        for (const [id, record] of [...this.records]) {
            if (record.scope === 'session' && record.sessionId === sessionId) {
                this.records.delete(id);
                removed += 1;
            }
        }
        return removed;
    }
}

export type InvocationResult =
    | { kind: 'executed'; value: unknown; untrusted?: boolean }
    | { kind: 'pending'; handle: PendingHandle; capability: string; hint: string }
    | { kind: 'failed'; error: string; code: AuthzErrorCode }
    | { kind: 'rejected'; code: AuthzErrorCode; hint: string; question?: Question };

/**
 * Canonical pipeline stages. Dataflow operations map onto them: risk-check
 * answers Q1/Q2/Q3, ledger-adjudication runs the outbound check, execute
 * resolves vouchers, writeback commits the read and applies residue taint.
 */
export const GATEWAY_PIPELINE_STAGES = [
    'supply-check',
    'scope-check',
    'risk-check',
    'ledger-adjudication',
    'approval',
    'execute',
    'writeback',
    'audit',
] as const;

export type GatewayStage = (typeof GATEWAY_PIPELINE_STAGES)[number];

export interface GatewayAuditEvent {
    stage: GatewayStage;
    decision: 'allowed' | 'denied' | 'pending' | 'info';
    identifiers: AuditIdentifiers;
    tool?: string;
    capability?: string;
    detail?: string;
    code?: AuthzErrorCode;
    question?: Question;
}

export interface GatewayAuditSink {
    log(event: GatewayAuditEvent): void;
}

export interface GatewayBindInput {
    /** Harness-injected identity; stepId is filled per invocation. */
    identifiers: Omit<AuditIdentifiers, 'stepId'> & { stepId?: string };
    policy: EffectivePolicy;
    labels: AssetLabelRegistry;
    ledger: DataflowLedger;
    taint: TaintTable;
    secretService?: SecretService;
    toolRegistry: ReadonlyMap<string, ToolRegistration>;
    budget?: Budget;
    approval?: ApprovalSeam;
    /** Process-level session/workspace grants; omit for per-gateway lifetime. */
    approvalStore?: ApprovalStore;
    /** 当前会话 id；session 作用域授权据此匹配，workspace 忽略。 */
    sessionId?: string;
    /** 命令分类规则（运行时从配置加载）；缺省只用代码硬条件（空策略）。 */
    commandPolicy?: CommandPolicy;
    audit: GatewayAuditSink;
    now?: () => number;
}

export interface ToolGateway {
    readonly stageNames: readonly GatewayStage[];
    invoke(req: InvocationRequest): Promise<InvocationResult>;
}

/** Re-exported for registration convenience. */
export type { CapabilitySpec, SecretRef };
