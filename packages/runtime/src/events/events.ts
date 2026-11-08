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
    'plan.revised',
    'replan.rejected',
    'capacity.assembled',
    'capacity.degraded',
    'toolset.assembled',
    'superagent.decision',
    'prompt.pack.selected',
    'verification.completed',
    'delegation.started',
    'delegation.completed',
    'delegation.rejected',
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
    /**
     * 执行前置阶段的进度（triage → 计划生成 → 开始执行）。
     * goal 级事件（无 taskId/stepId）：这些模型轮次发生在首个 Step 之前，
     * 没有 Step 可承载，UI 据此显示真实阶段而不是泛化的「执行中」占位。
     */
    'goal.phase',
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
