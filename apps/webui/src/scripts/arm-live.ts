/**
 * arm-live —— AB 实验室单臂的实时投影（纯函数，供实验台与单测共用）。
 *
 * 数据来源与主对话完全一致：GET /api/events/:rootGoalId?follow=1 的 SSE 事件流
 * （step.started / step.ended / llm.stream_event / approval.* / goal.ended / run.aborted）。
 * 纯函数：不碰 DOM、不读时间（now 可注入），因此可单测且可重放。
 */

import type { EventItem, StepUsage } from '../types.js';
import {
    activeStream,
    applyStreamEvent,
    clearStreamsForTask,
    type LiveStreamMap,
} from './stream.js';

/** 执行中的一步（与 store.LiveStep 同形；实时渲染用）。 */
export interface LiveStep {
    stepId: string;
    taskId: string;
    kind: string;
    toolName: string;
    /** deliberation：推理文本。 */
    thinking?: string;
    /** deliberation：模型回答。 */
    answer?: string;
    /** invocation：工具输出。 */
    output?: string;
    title: string;
    content: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    usage: StepUsage | null;
}

/** 待应答审批（SSE approval.requested 载荷的行内投影）。 */
export interface ArmApproval {
    invocationId: string;
    toolName: string;
    summary: string;
    requestedAt: number;
}

export type ArmLiveStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

export interface ArmLive {
    status: ArmLiveStatus;
    steps: LiveStep[];
    streams: LiveStreamMap;
    approvals: ArmApproval[];
    error: string;
}

/** SSE 事件类型白名单（实验台只订阅这些）。 */
export const ARM_EVENT_TYPES = [
    'step.started',
    'step.ended',
    'llm.stream_event',
    'approval.requested',
    'approval.granted',
    'approval.cancelled',
    'goal.ended',
    'run.aborted',
    'llm.error',
] as const;

export function initialArmLive(status: ArmLiveStatus = 'idle'): ArmLive {
    return { status, steps: [], streams: {}, approvals: [], error: '' };
}

function timestampOf(event: EventItem): number {
    return typeof event.timestamp === 'number' ? event.timestamp : Date.now();
}

/** step 事件 → 一行实时步骤（缺字段一律降级为空，不抛错）。 */
export function liveStepOf(event: EventItem, fallbackStatus: string): LiveStep {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const content = typeof payload.content === 'string' ? payload.content : '';
    const status = typeof payload.status === 'string' ? payload.status : fallbackStatus;
    const at = timestampOf(event);
    return {
        stepId: String(event.stepId ?? ''),
        taskId: String(event.taskId ?? ''),
        kind: String(payload.kind ?? 'step'),
        toolName: typeof payload.toolName === 'string' ? payload.toolName : '',
        thinking: typeof payload.thinking === 'string' ? payload.thinking : undefined,
        answer: typeof payload.answer === 'string' ? payload.answer : undefined,
        output: typeof payload.output === 'string' ? payload.output : undefined,
        title: content.replace(/\s+/g, ' ').trim().slice(0, 80),
        content,
        status,
        startedAt: at,
        // pending/active 均视为未结束：pending 是「已安排未执行」。
        endedAt: status === 'active' || status === 'pending' ? null : at,
        usage: (payload.usage as StepUsage | undefined) ?? null,
    };
}

/** step.started：追加一行，并把仍标记 active 的步骤收尾。 */
export function applyStepStarted(list: readonly LiveStep[], event: EventItem): LiveStep[] {
    const at = timestampOf(event);
    const closed = list.map((step) =>
        step.status === 'active' ? { ...step, status: 'succeeded', endedAt: at } : step,
    );
    return [...closed, liveStepOf(event, 'active')];
}

/** step.ended：按 stepId 原地更新（工具调用 running → ok/error）。 */
export function applyStepEnded(list: readonly LiveStep[], event: EventItem): LiveStep[] {
    const updated = liveStepOf(event, 'succeeded');
    const index = list.findIndex((step) => step.stepId === updated.stepId);
    if (index < 0) return [...list, updated];
    return list.map((step, position) =>
        position === index
            ? {
                  ...step,
                  status: updated.status,
                  content: updated.content,
                  title: updated.title,
                  ...(updated.toolName ? { toolName: updated.toolName } : {}),
                  endedAt: updated.endedAt,
              }
            : step,
    );
}

function approvalOf(event: EventItem): ArmApproval {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : '';
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : '';
    const summary =
        typeof payload.summary === 'string'
            ? payload.summary
            : typeof payload.reason === 'string'
              ? payload.reason
              : '';
    return { invocationId, toolName, summary, requestedAt: timestampOf(event) };
}

/** 归约一条 SSE 事件（返回新对象；同一引用表示无变化，避免无谓渲染）。 */
export function applyArmEvent(state: ArmLive, event: EventItem, now: number = Date.now()): ArmLive {
    switch (event.type) {
        case 'step.started':
            return { ...state, steps: applyStepStarted(state.steps, event) };
        case 'step.ended': {
            const payload = (event.payload || {}) as Record<string, unknown>;
            const steps = applyStepEnded(state.steps, event);
            // 该轮模型输出已落库：清掉对应 task 的流式增量，避免正文闪烁。
            const taskId = typeof event.taskId === 'string' ? event.taskId : '';
            const streams =
                payload.kind === 'deliberation' && taskId
                    ? clearStreamsForTask(state.streams, taskId)
                    : state.streams;
            return { ...state, steps, streams };
        }
        case 'llm.stream_event': {
            const streams = applyStreamEvent(state.streams, event, now);
            return streams === state.streams ? state : { ...state, streams };
        }
        case 'approval.requested': {
            const approval = approvalOf(event);
            if (approval.invocationId.length === 0) return state;
            if (state.approvals.some((item) => item.invocationId === approval.invocationId)) {
                return state;
            }
            return { ...state, approvals: [...state.approvals, approval] };
        }
        case 'approval.granted':
        case 'approval.cancelled': {
            const payload = (event.payload || {}) as Record<string, unknown>;
            const invocationId =
                typeof payload.invocationId === 'string' ? payload.invocationId : '';
            const approvals = state.approvals.filter((item) => item.invocationId !== invocationId);
            return approvals.length === state.approvals.length ? state : { ...state, approvals };
        }
        case 'goal.ended': {
            const payload = (event.payload || {}) as Record<string, unknown>;
            const outcome = (payload.outcome || {}) as Record<string, unknown>;
            const status: ArmLiveStatus = outcome.status === 'success' ? 'completed' : 'failed';
            return { ...state, status, approvals: [] };
        }
        case 'run.aborted':
            return { ...state, status: 'aborted', approvals: [] };
        case 'llm.error': {
            const payload = (event.payload || {}) as Record<string, unknown>;
            const message = typeof payload.message === 'string' ? payload.message : '模型调用失败';
            return { ...state, error: message };
        }
        default:
            return state;
    }
}

/** 当前活跃流式文本（reasoning + text，后写者优先）。 */
export function armStreamText(state: ArmLive | undefined): string {
    if (state === undefined) return '';
    const stream = activeStream(state.streams);
    if (stream === null) return '';
    return [stream.reasoning, stream.text].filter((part) => part.length > 0).join('\n');
}
