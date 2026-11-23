import { type EffectRecord, type EffectStore, rollbackEffects } from '../effects/effect-store.js';
import type { DefaultEventBus } from '../events/event-bus.js';
import { newHarnessEvent } from '../events/event-bus.js';

/**
 * 回滚 Goal 的全部已记录副作用（从 HarnessRuntime 抽出）。
 *
 * 需要工作区根路径才能定位快照；逐个 effect 发 rollback.executed 事件，
 * 返回最新的 effect 记录（status 已更新）。
 */
export async function rollbackGoalEffects(
    store: EffectStore,
    bus: DefaultEventBus,
    workspaceRoot: string | undefined,
    rootGoalId: string,
): Promise<EffectRecord[]> {
    if (workspaceRoot === undefined) {
        throw new Error('回滚需要工作区根路径');
    }
    const effects = await rollbackEffects(store, rootGoalId, workspaceRoot);
    for (const effect of effects) {
        bus.emit(
            newHarnessEvent({
                type: 'rollback.executed',
                rootGoalId,
                goalId: effect.goalId,
                taskId: effect.taskId,
                stepId: effect.stepId,
                attributes: {
                    'harness.level': effect.status === 'rolled-back' ? 'info' : 'error',
                },
                payload: {
                    effectId: effect.effectId,
                    status: effect.status,
                    paths: effect.before.map((item) => item.path),
                    ...(effect.error !== undefined ? { error: effect.error } : {}),
                },
            }),
        );
    }
    await bus.flush();
    return effects;
}
