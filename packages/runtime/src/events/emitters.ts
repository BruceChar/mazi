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
