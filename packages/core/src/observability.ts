import type { StepKind } from './gts.js';
import type { ApprovalScope, PermissionLevel } from './permissions.js';

/** Task-level tag (open string; expressed on the gts task model) */
type TaskTag = string & {};

/**
 * Trace identifiers for general events — hierarchical identity along the
 * gts model (goal/task/step). rootGoalId is the top-level anchor and is
 * always required; deeper levels are present depending on the event's scope.
 * Audit events require all four levels — see AuditIdentifiers.
 */
export interface TraceIdentifiers {
    /** Root anchor: the root goal id */
    rootGoalId: string;
    /** Owning goal (optional on general events) */
    goalId?: string;
    /** Owning task (optional on general events) */
    taskId?: string;
    /** Owning step (optional on general events) */
    stepId?: string;
}

/**
 * Audit identifiers — all four levels required (root goal / goal / task /
 * step): any missing is an implementation defect. Used by
 * GatewayAuditEvent (authz/gateway.ts) and hook contexts, where the full
 * decision chain must be reconstructable.
 */
export interface AuditIdentifiers {
    /** Root anchor: the root goal id */
    rootGoalId: string;
    /** Owning goal of the audited invocation */
    goalId: string;
    /** Owning task of the audited invocation */
    taskId: string;
    /** Owning step of the audited invocation */
    stepId: string;
}

/**
 * 核心事件类型 —— 任何宿主（runtime/api/provider/webui）都应支持的最小契约面：
 * 生命周期、模型调用、工具、权限、审批、提供方、用户。
 * runtime 层的执行行为事件（plan/capacity/budget/strategy/reflection/rollback）
 * 不属于本集合 —— 由 runtime 的 RUNTIME_EVENT_TYPES 声明。
 */
export type CoreEventType =
    | 'goal.started'
    | 'goal.ended'
    | 'task.started'
    | 'task.ended'
    | 'step.started'
    | 'step.ended'
    | 'llm.request'
    | 'llm.stream_event'
    | 'llm.response'
    /** 模型调用失败（含厂商原始错误码/消息）；供 UI 与自愈消费 */
    | 'llm.error'
    /** 自愈成功（如重同步模型后换模重试成功） */
    | 'provider.recovered'
    | 'tool.invoke'
    | 'tool.result'
    | 'tool.blocked'
    | 'policy.check'
    | 'policy.denied'
    | 'approval.requested'
    | 'approval.granted'
    | 'approval.cancelled'
    /** session/workspace 批准放行一次调用（V8/审计：每次命中必须留痕） */
    | 'approval.hit'
    /** workspace 级批准被撤销（或 workspace 删除） */
    | 'approval.revoked'
    | 'provider.selected'
    | 'provider.fallback'
    | 'flag.evaluated'
    | 'user.input.recorded'
    | 'user.feedback.captured'
    | 'user.interaction.updated';

/**
 * 事件类型 —— 核心契约面 + 宿主扩展。
 * 扩展侧开放为字符串（runtime 层以 RUNTIME_EVENT_TYPES 声明其受控集合）。
 */
export type HarnessEventType = CoreEventType | (string & {});

/**
 * Audit-to-harness bridge contract — maps every GatewayAuditEvent
 * (tool-gateway.ts) onto a HarnessEvent on the bus.
 *
 *   GatewayAuditEvent.decision → HarnessEvent.type
 *     allowed   → 'tool.invoke'     (terminal execute decision)
 *     denied    → 'policy.denied'
 *     pending   → 'approval.requested'
 *     info      → 'policy.check'    (escalation short-circuit, supply checks,
 *                                    budget accounting)
 *   Settlement (ApprovalResult)  → 'approval.granted' | 'approval.cancelled'
 *   Session/workspace approval hit → 'approval.hit'
 *   Workspace revocation           → 'approval.revoked'
 *
 *   GatewayAuditEvent fields → attributes
 *     stage         → 'harness.gateway_stage'
 *     effectClass   → 'harness.gateway_effect_class'
 *     dangerRuleId  → 'harness.gateway_danger_rule'
 *     escalation    → payload (serialized)
 *
 * The audit sink's identifiers are AuditIdentifiers (all four levels
 * required) and are carried verbatim on the emitted event.
 */

/** 统一事件结构 */
export interface HarnessEvent extends TraceIdentifiers {
    eventId: string;
    type: HarnessEventType;
    timestamp: number;
    attributes: {
        'gen_ai.operation.name'?: string;
        'gen_ai.request.model'?: string;
        'gen_ai.provider.name'?: string;
        'gen_ai.usage.input_tokens'?: number;
        'gen_ai.usage.output_tokens'?: number;
        'gen_ai.usage.cache_read.input_tokens'?: number;
        'harness.step_kind'?: StepKind;
        'harness.permission_level'?: PermissionLevel;
        /** 事件严重级（EventFilter.minLevel 的判定来源） */
        'harness.level'?: 'debug' | 'info' | 'warn' | 'error';
        'harness.task_tags'?: TaskTag[];
        'harness.gateway_stage'?: string;
        'harness.gateway_effect_class'?: string;
        'harness.gateway_danger_rule'?: string;
        'harness.approval_scope'?: ApprovalScope;
        'harness.approval_effect_class'?: string;
        'harness.flag_overrides'?: Record<string, unknown>;
        'user.record_id'?: string;
        'user.feedback_type'?: string;
        [k: string]: unknown;
    };
    payload?: unknown;
}

/** 事件过滤器 */
export interface EventFilter {
    types?: HarnessEventType[];
    /**
     * 最低严重级：按事件 attributes['harness.level'] 判定；
     * 事件未携带 level 时视为不匹配（保守拒绝）。
     */
    minLevel?: 'debug' | 'info' | 'warn' | 'error';
    requireFlag?: {
        key: string;
        equals?: unknown;
    };
}

/** 取消订阅函数 */
export type Unsubscribe = () => void;

/** 事件消费者 */
export interface EventSink {
    id: string;
    handle(event: HarnessEvent): Promise<void> | void;
}

/** 事件总线：emit 永不被 flag 阻断，且默认落盘 */
export interface EventBus {
    emit(event: HarnessEvent): void;
    subscribe(filter: EventFilter, sink: EventSink): Unsubscribe;
    /** 事件流回放（只读重放，按 rootGoalId 分文件） */
    replay(rootGoalId: string): HarnessEvent[];
}
