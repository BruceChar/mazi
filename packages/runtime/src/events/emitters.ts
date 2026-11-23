import type { Fault, FaultRecovery } from '../faults/types.js';
import type { DefaultEventBus } from './event-bus.js';
import { newHarnessEvent } from './event-bus.js';

/** Goal 执行前置阶段（入口/triage、规划、执行）。 */
export type GoalPhase = 'intake' | 'planning' | 'executing';

/**
 * 无状态的 harness 事件发射器（从 HarnessRuntime 抽出）。
 * 只依赖事件总线，因此也可被插件/测试直接用（不需要整个运行时）。
 */

/**
 * 执行前置阶段的进度事件（仅观测）：triage/规划这类发生在首个 Step 之前的模型工作
 * 也必须有可观测锚点，UI 才能显示真实阶段而非泛化占位。goal 级事件，不带 taskId/stepId。
 */
export async function emitGoalPhase(
    bus: DefaultEventBus,
    rootGoalId: string,
    goalId: string,
    phase: GoalPhase,
    label: string,
): Promise<void> {
    bus.emit(
        newHarnessEvent({
            type: 'goal.phase',
            rootGoalId,
            goalId,
            payload: { phase, label },
        }),
    );
    await bus.flush();
}

/** Skill 运行边界事件：携 harness.skill_id（可回放"本次运行带上了哪些技能"）。 */
export function emitSkillEvent(
    bus: DefaultEventBus,
    type: 'capability.activated' | 'capability.deactivated',
    skillId: string,
    rootGoalId: string,
    goalId: string,
): void {
    bus.emit(
        newHarnessEvent({
            type,
            rootGoalId,
            goalId,
            attributes: { 'harness.skill_id': skillId, 'harness.level': 'info' },
            payload: { skillId },
        }),
    );
}

/**
 * 错误层事件：每次处置决策/恢复成功都留痕（设计 §7）。
 * 无 rootGoalId 的故障（理论上面向会话）直接丢弃，避免产生无锚点事件。
 */
export function emitFault(
    bus: DefaultEventBus,
    type: 'fault.raised' | 'fault.recovered',
    fault: Fault,
    recovery?: FaultRecovery,
): void {
    const identifiers = fault.identifiers;
    const rootGoalId = identifiers?.rootGoalId;
    if (rootGoalId === undefined || rootGoalId.length === 0) return;
    bus.emit(
        newHarnessEvent({
            type,
            rootGoalId,
            ...(identifiers?.goalId !== undefined ? { goalId: identifiers.goalId } : {}),
            ...(identifiers?.sessionId !== undefined ? { sessionId: identifiers.sessionId } : {}),
            ...(identifiers?.taskId !== undefined ? { taskId: identifiers.taskId } : {}),
            ...(identifiers?.stepId !== undefined ? { stepId: identifiers.stepId } : {}),
            attributes: {
                'harness.fault_domain': fault.domain,
                'harness.fault_kind': fault.kind,
                'harness.fault_severity': fault.severity,
                'harness.fault_scope': fault.scope,
                'harness.level': fault.severity === 'fatal' ? 'error' : 'warn',
                ...(recovery !== undefined
                    ? {
                          'harness.fault_action': recovery.action,
                          'harness.fault_attempt': recovery.attempt,
                      }
                    : {}),
            },
            payload: {
                message: fault.message.slice(0, 400),
                ...(fault.code !== undefined ? { code: fault.code } : {}),
                ...(fault.hint !== undefined ? { hint: fault.hint } : {}),
            },
        }),
    );
}

/** 功能开关求值结果：记录覆盖值、生效 id 与逐项来源（仅观测）。 */
export function emitFlagEvent(
    bus: DefaultEventBus,
    rootGoalId: string,
    goalId: string,
    values: Record<string, boolean>,
    trace: ReadonlyArray<{ id: string; enabled: boolean; source: string }>,
): void {
    const enabledIds = Object.entries(values)
        .filter(([, enabled]) => enabled)
        .map(([id]) => id)
        .sort();
    bus.emit(
        newHarnessEvent({
            type: 'flag.evaluated',
            rootGoalId,
            goalId,
            attributes: {
                'harness.flag_overrides': { ...values },
                'harness.feature_ids': enabledIds,
            },
            payload: { values: { ...values }, trace: trace.map((step) => ({ ...step })) },
        }),
    );
}
