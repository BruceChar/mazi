/**
 * Runtime-layer event extensions.
 *
 * core's HarnessEventType carries only the universal contract surface
 * (lifecycle / llm / tool / policy / approval / provider / user). The
 * execution-loop behavior events — planning, capacity assembly, budget,
 * strategy, reflection, rollback — belong to the runtime layer and are
 * declared here. They remain expressible on HarnessEvent.type via the
 * open string extension.
 */
export const RUNTIME_EVENT_TYPES = [
    'plan.created',
    'plan.invalid',
    'capacity.assembled',
    'capacity.degraded',
    'budget.reallocation',
    'budget.exceeded',
    'strategy.selected',
    'strategy.switched',
    'context.strategy.applied',
    'reflection.verdict',
    'rollback.executed',
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

/**
 * Runtime-layer extended attributes — typed keys outside the core contract.
 * core's HarnessEvent.attributes carries them via the open index signature;
 * this type restores checked shapes for runtime-emitted events.
 */
export interface RuntimeEventAttributes {
    'harness.strategy_id'?: string;
    'harness.runtime.context.system_prompt_ratio'?: number;
    'harness.runtime.context.total_tokens'?: number;
    'harness.pricing_tier'?: string;
}
