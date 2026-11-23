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
    /** workflow 节点角色（dynamic loop）；缺省时按 kind 推导展示名。 */
    role?: string;
    toolName: string;
    /** invocation：工具参数。 */
    toolArguments?: Record<string, unknown>;
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

/** dynamic loop 的真实节点（Think/Act/Observe/Reflect），与工具行分开展示。 */
export interface LiveWorkflowNode {
    key: string;
    kind: string;
    role: string;
    nodeId: string;
    reason: string;
    at: number;
}

export interface ArmLive {
    status: ArmLiveStatus;
    steps: LiveStep[];
    nodes: LiveWorkflowNode[];
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
    'workflow.node',
] as const;

export function initialArmLive(status: ArmLiveStatus = 'idle'): ArmLive {
    return { status, steps: [], nodes: [], streams: {}, approvals: [], error: '' };
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
    const toolName =
        typeof payload.toolName === 'string'
            ? payload.toolName
            : typeof payload.tool === 'string'
              ? payload.tool
              : '';
    const toolArguments = argumentsFromPayload(payload, content, toolName);
    return {
        stepId: String(event.stepId ?? ''),
        taskId: String(event.taskId ?? ''),
        kind: String(payload.kind ?? 'step'),
        ...(typeof payload.role === 'string' ? { role: payload.role } : {}),
        toolName,
        ...(toolArguments ? { toolArguments } : {}),
        thinking: typeof payload.thinking === 'string' ? payload.thinking : undefined,
        answer: typeof payload.answer === 'string' ? payload.answer : undefined,
        output: typeof payload.output === 'string' ? payload.output : undefined,
        title: stepTitleOf({
            kind: String(payload.kind ?? 'step'),
            toolName,
            toolArguments,
            thinking: typeof payload.thinking === 'string' ? payload.thinking : '',
            answer: typeof payload.answer === 'string' ? payload.answer : '',
            content,
        }),
        content,
        status,
        startedAt: at,
        // pending/active 均视为未结束：pending 是「已安排未执行」。
        endedAt: status === 'active' || status === 'pending' ? null : at,
        usage: (payload.usage as StepUsage | undefined) ?? null,
    };
}

/**
 * 实时行摘要：工具行显示「工具名 + 参数」，思考行显示正文。
 * 模型只发起工具调用而不写正文时，思考行会给占位文案，避免出现一条空白行。
 */
function stepTitleOf(input: {
    kind: string;
    toolName: string;
    toolArguments: Record<string, unknown> | undefined;
    thinking: string;
    answer: string;
    content: string;
}): string {
    if (input.kind === 'invocation') {
        const args =
            input.toolArguments !== undefined ? ` ${compactJson(input.toolArguments)}` : '';
        return `${input.toolName || '工具'}${args}`.slice(0, 200);
    }
    const text = firstText([input.thinking, input.answer, input.content]);
    return text.length > 0 ? text.slice(0, 80) : '（无正文，直接发起下一步）';
}

function firstText(values: string[]): string {
    for (const value of values) {
        const text = value.replace(/\s+/g, ' ').trim();
        if (text.length > 0) return text;
    }
    return '';
}

function compactJson(value: Record<string, unknown>): string {
    try {
        return JSON.stringify(value);
    } catch {
        return '{}';
    }
}

function argumentsFromPayload(
    payload: Record<string, unknown>,
    content: string,
    toolName: string,
): Record<string, unknown> | undefined {
    if (
        payload.arguments !== null &&
        typeof payload.arguments === 'object' &&
        !Array.isArray(payload.arguments)
    ) {
        return payload.arguments as Record<string, unknown>;
    }
    if (!toolName || !content.startsWith(`${toolName} `)) return undefined;
    try {
        const parsed = JSON.parse(content.slice(toolName.length + 1)) as unknown;
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
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
                  ...(updated.role ? { role: updated.role } : {}),
                  ...(updated.toolName ? { toolName: updated.toolName } : {}),
                  ...(updated.thinking ? { thinking: updated.thinking } : {}),
                  ...(updated.answer ? { answer: updated.answer } : {}),
                  ...(updated.output ? { output: updated.output } : {}),
                  ...(updated.toolArguments ? { toolArguments: updated.toolArguments } : {}),
                  endedAt: updated.endedAt,
              }
            : step,
    );
}

function approvalOf(event: EventItem): ArmApproval {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const invocationId = typeof payload.invocationId === 'string' ? payload.invocationId : '';
    const toolName =
        typeof payload.toolName === 'string'
            ? payload.toolName
            : typeof payload.tool === 'string'
              ? payload.tool
              : '';
    const summary =
        typeof payload.summary === 'string'
            ? payload.summary
            : typeof payload.reason === 'string'
              ? payload.reason
              : '';
    return { invocationId, toolName, summary, requestedAt: timestampOf(event) };
}

/** workflow.node 事件 → 独立节点行（历史回放与实时共用）。 */
export function workflowNodeOf(event: EventItem): LiveWorkflowNode | null {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const kind = typeof payload.kind === 'string' ? payload.kind : 'node.selected';
    const role = typeof payload.role === 'string' ? payload.role : '';
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : '';
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    const at = timestampOf(event);
    const key = `${at}-${kind}-${nodeId}`;
    return { key, kind, role, nodeId, reason, at };
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
        case 'workflow.node': {
            const node = workflowNodeOf(event);
            if (node === null || state.nodes.some((item) => item.key === node.key)) return state;
            return { ...state, nodes: [...state.nodes, node] };
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
