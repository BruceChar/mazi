import type { EffectClass, PermissionLevel } from './authorization.js';
import type { ApprovalScope } from './approval.js';
import type { StepKind } from './gts.js';

/** 迁移期标签类型（旧 turn-contract 移除后以开放字符串表达） */
type TaskTag = string & {};

/**
 * Trace identifiers for general events — hierarchical identity along the
 * gts model (goal/task/step). sessionId is the root anchor (rootGoalId) and
 * is always required; deeper levels are present depending on the event's
 * scope. Audit events require all three core levels — see AuditIdentifiers.
 *
 * Vocabulary note: turnId/stepId are legacy turn-contract terms, kept for
 * migration compatibility (runtime still emits them); goalId/taskId align
 * with the gts Goal/Task model and are the forward vocabulary.
 */
export interface TraceIdentifiers {
    /** Root anchor: the root goal id (rootGoalId) */
    sessionId: string;
    /** Legacy turn id (old turn-contract vocabulary); migration-period alias */
    turnId?: string;
    /** Legacy step id; gts step id (migration-period alias) */
    stepId?: string;
    /** gts alignment: owning goal (optional on general events) */
    goalId?: string;
    /** gts alignment: owning task (optional on general events) */
    taskId?: string;
}

/**
 * Audit identifiers — all three core levels required (v2 observability
 * alignment): any missing is an implementation defect. Used by
 * GatewayAuditEvent (tool-gateway.ts) and hook contexts, where the full
 * decision chain must be reconstructable.
 */
export interface AuditIdentifiers {
    /** Root anchor: the root goal id (rootGoalId) */
    sessionId: string;
    /** Owning turn/task of the audited invocation */
    turnId: string;
    /** Owning step of the audited invocation */
    stepId: string;
    /** gts alignment: owning goal */
    goalId?: string;
    /** gts alignment: owning task */
    taskId?: string;
}

/** Harness 事件类型 */
export type HarnessEventType =
    | 'session.started'
    | 'session.ended'
    | 'turn.started'
    | 'turn.ended'
    | 'step.started'
    | 'step.ended'
    | 'llm.request'
    | 'llm.stream_event'
    | 'llm.response'
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
    | 'plan.created'
    | 'plan.invalid'
    | 'capacity.assembled'
    | 'capacity.degraded'
    | 'budget.reallocation'
    | 'budget.exceeded'
    | 'strategy.selected'
    | 'strategy.switched'
    | 'context.strategy.applied'
    | 'flag.evaluated'
    | 'reflection.verdict'
    | 'rollback.executed'
    | 'user.input.recorded'
    | 'user.feedback.captured'
    | 'user.interaction.updated';

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
 * The audit sink's identifiers are AuditIdentifiers (all three core levels
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
        'harness.strategy_id'?: string;
        'harness.turn_tags'?: TaskTag[];
        'harness.gateway_stage'?: string;
        'harness.gateway_effect_class'?: string;
        'harness.gateway_danger_rule'?: string;
        'harness.approval_scope'?: ApprovalScope;
        'harness.approval_effect_class'?: EffectClass;
        'harness.runtime.context.system_prompt_ratio'?: number;
        'harness.runtime.context.total_tokens'?: number;
        'harness.pricing_tier'?: string;
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
    /** 事件流回放（只读重放） */
    replay(sessionId: string): HarnessEvent[];
}
