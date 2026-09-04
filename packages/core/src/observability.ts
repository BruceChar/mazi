import type { PermissionLevel } from './capacity';
import type { StepKind } from './session';
import type { TaskTag } from './turn-contract';

/** 三层 ID 是所有事件的必备字段 */
export interface TraceIdentifiers {
    sessionId: string;
    turnId?: string;
    stepId?: string;
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
