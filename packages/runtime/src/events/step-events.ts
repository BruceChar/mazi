import type { Step } from '@mazi/core';
import { usageViewOf } from '../observability/usage-view.js';
import { type DefaultEventBus, newHarnessEvent } from './event-bus.js';

/** Step payload → 完整文本（大上限 60k；长内容由 UI 滚动窗口承载） */
function stepText(step: Step): string {
    let text: string;
    if (step.kind === 'deliberation') {
        const { thinking, answer } = step.payload;
        text = [thinking ?? '', answer ?? ''].filter((part) => part.length > 0).join('\n\n');
    } else {
        const { toolName, arguments: args, output } = step.payload;
        text = `${toolName} ${JSON.stringify(args ?? {})}`;
        // Include the settled result so live consumers see tool output/failures
        // immediately instead of only after the run-time snapshot refresh.
        if (output) {
            text += `\n${step.status === 'error' ? '[error] ' : '→ '}${output}`;
        }
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
        // 结构化字段一并发出：单条 deliberation 可同时含 thinking/answer/toolCalls，
        // 实时消费方（SSE/UI）据此自行分段渲染，无需再从文本反解。
        const payload: Record<string, unknown> = {
            kind: step.kind,
            status: step.status,
            goalId: step.goalId,
            taskId: step.taskId,
            content: stepText(step),
        };
        if (step.kind === 'deliberation') {
            if (step.payload.thinking !== undefined) payload.thinking = step.payload.thinking;
            if (step.payload.answer !== undefined) payload.answer = step.payload.answer;
            if (step.payload.toolCalls !== undefined) payload.toolCalls = step.payload.toolCalls;
        } else {
            payload.toolName = step.payload.toolName;
            if (step.payload.output !== undefined) payload.output = step.payload.output;
        }
        if (step.error !== undefined) payload.error = step.error;
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
