/**
 * behavior-rows —— 用户行为指令 → 执行流展示行（纯函数，供 ExecStream.vue 与单测）。
 *
 * 顺序遵循 @mazi/libs 的 projectBehaviorTimeline（同 at 行为在前），
 * 仅呈现「审批发起 / 用户授权 / 用户反馈」；问题（input）已由会话流的用户气泡承载。
 */

import type { StepView, UserBehaviorView } from '@mazi/libs';
import { projectBehaviorTimeline } from '@mazi/libs';

/** 执行流中渲染的行为行。 */
export interface BehaviorRow {
    key: string;
    type: 'approval' | 'authorization' | 'feedback';
    at: number;
    icon: string;
    label: string;
    summary: string;
}

export type RenderableBehaviorType = BehaviorRow['type'];

const RENDERABLE: readonly RenderableBehaviorType[] = ['approval', 'authorization', 'feedback'];

function isRenderable(type: string): type is RenderableBehaviorType {
    return (RENDERABLE as readonly string[]).includes(type);
}

function textOf(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function iconOf(behavior: UserBehaviorView): string {
    if (behavior.type === 'approval') return 'info';
    if (behavior.type === 'authorization') return 'shield';
    if (behavior.data.kind === 'rating') {
        return Number(behavior.data.rating) >= 4 ? 'like' : 'dislike';
    }
    if (behavior.data.kind === 'interrupt') return 'stop';
    return 'userMessage';
}

function labelOf(type: RenderableBehaviorType): string {
    if (type === 'approval') return '审批';
    if (type === 'authorization') return '授权';
    return '反馈';
}

function summaryOf(behavior: UserBehaviorView): string {
    if (behavior.type === 'approval') {
        return textOf(behavior.data.summary) || textOf(behavior.data.capability) || '待审批';
    }
    if (behavior.type === 'authorization') {
        const decision =
            behavior.data.decision === 'granted'
                ? '允许'
                : behavior.data.decision === 'denied'
                  ? '拒绝'
                  : textOf(behavior.data.decision);
        const scope = textOf(behavior.data.scope);
        const latency =
            typeof behavior.data.latencyMs === 'number' ? behavior.data.latencyMs + 'ms' : '';
        return [decision, scope, latency].filter((part) => part.length > 0).join(' · ');
    }
    const kind = textOf(behavior.data.kind);
    if (kind === 'rating') return '评分 ' + String(behavior.data.rating ?? '-');
    if (kind === 'interrupt') return '主动中断';
    return textOf(behavior.data.text) || kind;
}

function toRow(behavior: UserBehaviorView): BehaviorRow {
    const type = behavior.type as RenderableBehaviorType;
    return {
        key: 'behavior-' + behavior.ts,
        type,
        at: behavior.ts,
        icon: iconOf(behavior),
        label: labelOf(type),
        summary: summaryOf(behavior),
    };
}

/**
 * Step 视图 + 行为流 → 可渲染行为行（按 projectBehaviorTimeline 的全局顺序）。
 * 过滤 input/setting/session：问题由用户气泡承载，设置/会话边界不属于执行流。
 */
export function behaviorRowsOf(
    steps: readonly StepView[],
    behaviors: readonly UserBehaviorView[],
): BehaviorRow[] {
    return projectBehaviorTimeline(steps, behaviors)
        .filter((entry) => entry.source === 'behavior')
        .map((entry) => entry.behavior)
        .filter((behavior) => isRenderable(behavior.type))
        .map(toRow);
}

/**
 * 按任务时间窗把行为行分组：第 i 组覆盖 [starts[i], starts[i+1])，首组向左开放、
 * 末组向右开放，保证每条行为只落到一个任务上（反馈在 run 结束后归末组）。
 * starts 必须非递减。
 */
export function groupBehaviorsByTask(
    starts: readonly number[],
    rows: readonly BehaviorRow[],
): BehaviorRow[][] {
    return starts.map((start, index) => {
        const end = index + 1 < starts.length ? starts[index + 1] : Number.POSITIVE_INFINITY;
        const from = index === 0 ? Number.NEGATIVE_INFINITY : start;
        return rows.filter((row) => row.at >= from && row.at < end);
    });
}
