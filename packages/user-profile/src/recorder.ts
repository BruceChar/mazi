import type {
    ActionSummary,
    EventBus,
    EventFilter,
    EventSink,
    HarnessEvent,
    MemoryStore,
    ThoughtSummary,
    Unsubscribe,
    UserFeedback,
    UserInteractionRecord,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { newHarnessEvent } from '@mazi/observability';
import { anonymizeText } from './anonymizer';

/** 摘要上限（MVP 文档 §5.5：thinking 概括 ≤200 字符，含省略号） */
const SUMMARY_MAX = 200;

function summarize(content: string, max = SUMMARY_MAX): string {
    const trimmed = content.replace(/\s+/g, ' ').trim();
    if (trimmed.length <= max) {
        return trimmed;
    }
    return `${trimmed.slice(0, max - 1)}…`;
}

function guessThoughtCategory(content: string): ThoughtSummary['category'] {
    if (/计划|分解|步骤|方案/.test(content) || /^\d+\./.test(content.trim())) {
        return 'planning';
    }
    if (/修正|重新|错误|纠正/.test(content)) {
        return 'self-correction';
    }
    return 'reasoning';
}

export interface RecorderRuntime {
    /** Flag：user-profile.enabled */
    enabled: () => boolean;
    /** Flag：user-profile.anonymize */
    anonymize: () => boolean;
    now?: () => number;
}

/**
 * 用户交互记录器（feature F13，MVP 文档 §5.5 / §6 A10）：
 * 订阅事件流：
 * - session.started（payload 含 rawInput/inputTimestamp/userId）→ 立即落库（recording）并 emit user.input.recorded
 * - step.ended（thinking/tool_call）→ 追加 ThoughtSummary/ActionSummary
 * - user.feedback.captured → 追加 UserFeedback
 * - session.ended（payload 含 outcome/metrics）→ 完成记录并 emit user.interaction.updated
 * 写库异步进行，不阻塞主流程。
 */
export class UserProfileRecorder implements EventSink {
    readonly id = 'user-profile-recorder';
    private readonly filter: EventFilter;
    private unsubscribe?: Unsubscribe;

    constructor(
        private readonly bus: EventBus,
        private readonly memory: MemoryStore,
        private readonly runtime: RecorderRuntime,
    ) {
        this.filter = {
            types: ['session.started', 'step.ended', 'user.feedback.captured', 'session.ended'],
        };
    }

    start(): void {
        this.unsubscribe = this.bus.subscribe(this.filter, this);
    }

    stop(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
    }

    handle(event: HarnessEvent): void {
        if (!this.runtime.enabled()) {
            return;
        }
        switch (event.type) {
            case 'session.started':
                this.onSessionStarted(event);
                break;
            case 'step.ended':
                void this.onStepEnded(event);
                break;
            case 'user.feedback.captured':
                void this.onFeedback(event);
                break;
            case 'session.ended':
                void this.onSessionEnded(event);
                break;
            default:
                break;
        }
    }

    private onSessionStarted(event: HarnessEvent): void {
        const payload = (event.payload ?? {}) as {
            rawInput?: string;
            inputTimestamp?: number;
            userId?: string;
        };
        const rawInput = payload.rawInput ?? '';
        const anonymize = this.runtime.anonymize();
        const record: UserInteractionRecord = {
            recordId: ulid(),
            sessionId: event.sessionId,
            userId: anonymize ? undefined : payload.userId,
            rawInput: anonymize ? anonymizeText(rawInput) : rawInput,
            inputTimestamp: payload.inputTimestamp ?? event.timestamp,
            thoughtTrace: [],
            actionTrace: [],
            feedback: [],
            metrics: {},
            status: 'recording',
            updatedAt: this.now(),
        };
        void this.memory.saveUserInteractionRecord(record).catch((error: unknown) => {
            process.stderr.write(`user-profile save record failed: ${String(error)}\n`);
        });
        this.bus.emit(
            newHarnessEvent({
                type: 'user.input.recorded',
                sessionId: event.sessionId,
                attributes: { 'user.record_id': record.recordId },
                payload: { recordId: record.recordId, anonymized: anonymize },
            }),
        );
    }

    private async onStepEnded(event: HarnessEvent): Promise<void> {
        const record = await this.loadBySession(event.sessionId);
        if (!record) {
            return;
        }
        const stepKind = event.attributes?.['harness.step_kind'];
        const seq = (event.payload as { seq?: number } | undefined)?.seq ?? 0;
        if (stepKind === 'thinking') {
            const content = (event.payload as { text?: string } | undefined)?.text ?? '';
            const thought: ThoughtSummary = {
                stepSeq: seq,
                summary: summarize(content),
                category: guessThoughtCategory(content),
            };
            record.thoughtTrace.push(thought);
        } else if (stepKind === 'tool_call') {
            const p = event.payload as { toolName?: string; result?: string } | undefined;
            const action: ActionSummary = {
                stepSeq: seq,
                actionType: 'tool_call',
                description: p?.toolName ? `调用 ${p.toolName}` : '调用工具',
                result: p?.result as ActionSummary['result'],
            };
            record.actionTrace.push(action);
        } else {
            return;
        }
        record.updatedAt = this.now();
        await this.memory.saveUserInteractionRecord(record);
    }

    private async onFeedback(event: HarnessEvent): Promise<void> {
        const record = await this.loadBySession(event.sessionId);
        if (!record) {
            return;
        }
        const feedback = (event.payload as { feedback?: UserFeedback } | undefined)?.feedback;
        if (feedback) {
            record.feedback.push(feedback);
            record.updatedAt = this.now();
            await this.memory.saveUserInteractionRecord(record);
        }
    }

    private async onSessionEnded(event: HarnessEvent): Promise<void> {
        const record = await this.loadBySession(event.sessionId);
        if (!record || record.status === 'completed') {
            return;
        }
        const payload = (event.payload ?? {}) as {
            outcome?: UserInteractionRecord['outcome'];
            metrics?: UserInteractionRecord['metrics'];
        };
        record.outcome = payload.outcome;
        record.metrics = payload.metrics ?? record.metrics;
        record.status = 'completed';
        record.updatedAt = this.now();
        await this.memory.saveUserInteractionRecord(record);
        this.bus.emit(
            newHarnessEvent({
                type: 'user.interaction.updated',
                sessionId: event.sessionId,
                attributes: { 'user.record_id': record.recordId },
                payload: { recordId: record.recordId, status: record.status },
            }),
        );
    }

    private async loadBySession(sessionId: string): Promise<UserInteractionRecord | undefined> {
        return this.memory.loadUserInteractionBySession(sessionId);
    }

    private now(): number {
        return this.runtime.now?.() ?? Date.now();
    }
}
