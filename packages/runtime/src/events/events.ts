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
    'toolset.assembled',
    'budget.reallocation',
    'budget.exceeded',
    'strategy.selected',
    'strategy.switched',
    'context.strategy.applied',
    'reflection.verdict',
    'rollback.executed',
    /** 协作式停止：运行在 Step 边界停下，Task/Goal 置 aborted 等待恢复 */
    'run.aborted',
    /** 从已落库 Step 重放后继续执行 */
    'run.resumed',
    /** Goal 创建时的 triage 判定：协商/升级/直答（goal 级，无 taskId） */
    'goal.negotiation.requested',
    /** 协商答复后修订并重新冻结契约（唯一合法迁移记录） */
    'goal.contract-revised',
    /** 运行收尾的契约满足度机械判定（评估器视角；goal 级，无 taskId） */
    'goal.contract-evaluated',
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
