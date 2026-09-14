import type { Step } from '@mazi/core';
import { type DefaultEventBus, newHarnessEvent, usageViewOf } from '../observability/index.js';

/** Step payload → 完整文本（大上限 60k；长内容由 UI 滚动窗口承载） */
function stepText(step: Step): string {
    const payload = step.payload;
    let text: string;
    if (step.kind === 'thinking') {
        text = String((payload as { content?: string }).content ?? '');
    } else if (step.kind === 'tool_call') {
        const call = payload as {
            toolName?: string;
            arguments?: unknown;
            callId?: string;
            output?: string;
            isError?: boolean;
        };
        text = `${call.toolName ?? ''} ${JSON.stringify(call.arguments ?? {})}`;
        // Include the settled result so live consumers see tool output/failures
        // immediately instead of only after the run-time snapshot refresh.
        if (call.output) {
            text += `\n${call.isError ? '[error] ' : '→ '}${call.output}`;
        }
    } else {
        const obs = payload as { toolName?: string; content?: string; isError?: boolean };
        text = `${obs.toolName ? `[${obs.toolName}] ` : ''}${obs.content ?? ''}${
            obs.isError ? '\n[error]' : ''
        }`;
    }
    return text.length > 60_000
        ? `${text.slice(0, 60_000)}\n…（content truncated at 60k chars）`
        : text;
}

/** Step 事件的去重发射器：step.started 仅首见一次，step.ended 每次落库都发。 */
export class StepEventEmitter {
    /** Steps already announced via step.started (a step persists several times). */
    private readonly startedStepIds = new Set<string>();

    constructor(private readonly bus: DefaultEventBus) {}

    /** Step 落库即时事件：经事件总线实时推送（SSE/UI 流式展示） */
    emitStep(rootGoalId: string, step: Step): void {
        const usage = usageViewOf(step.usage);
        const payload: Record<string, unknown> = {
            kind: step.kind,
            status: step.status,
            goalId: step.goalId,
            taskId: step.taskId,
            content: stepText(step),
        };
        if (usage !== undefined) {
            payload.usage = usage;
        }
        // Announce the step once when it first reaches the store, then emit an
        // ended event on every persist (tool calls: running -> ok updates).
        if (!this.startedStepIds.has(step.stepId)) {
            this.startedStepIds.add(step.stepId);
            this.bus.emit(
                newHarnessEvent({
                    type: 'step.started',
                    rootGoalId,
                    goalId: step.goalId,
                    taskId: step.taskId,
                    stepId: step.stepId,
                    payload,
                }),
            );
        }
        this.bus.emit(
            newHarnessEvent({
                type: 'step.ended',
                rootGoalId,
                goalId: step.goalId,
                taskId: step.taskId,
                stepId: step.stepId,
                payload,
            }),
        );
    }
}
