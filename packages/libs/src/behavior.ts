/**
 * 用户行为指令（User Behavior Instruction）与 Step 时间线投影契约。
 *
 * 用户行为（问题 / 反馈 / 授权）与审批发起锚点记录在独立的 append-only 行为流；
 * 本模块只定义线协议视图与把行为流合并进 Step 时间线的**只读纯函数**——
 * 不新增 StepKind、不写入 goal_steps（见 docs/用户行为流设计文档.md §10）。
 */

import type { StepView } from './types.js';

/** 用户行为指令（及审批发起锚点）的类型闭集。 */
export type UserBehaviorType =
    | 'input'
    | 'feedback'
    | 'authorization'
    | 'approval'
    | 'setting'
    | 'session';

/** ref.anchor：被指向对象的客观事实（有则盖、无则空）。 */
export interface UserBehaviorAnchor {
    tokens?: number;
    durationMs?: number;
    hadError?: boolean;
}

/** 关联指向（子行为所属 input、授权所属 approval 等）。 */
export interface UserBehaviorRef {
    ts: number;
    anchor?: UserBehaviorAnchor;
}

/** 一条用户行为指令（api/webui 共享视图）。 */
export interface UserBehaviorView {
    /** 事件 id = 流内唯一时间戳；排序依据与证据引用。 */
    ts: number;
    type: UserBehaviorType;
    ref?: UserBehaviorRef;
    /** 按 type 收窄的载荷（见设计文档 §2.3）。 */
    data: Record<string, unknown>;
}

/** 时间线条目：Step 与用户行为指令的只读合并视图。 */
export type TimelineEntry =
    | { source: 'step'; at: number; step: StepView }
    | { source: 'behavior'; at: number; behavior: UserBehaviorView };

/**
 * 把会话内 Step 与用户行为流合并为一条按时间排序的只读时间线。
 *
 * 规则（设计文档 §10.4）：`at` 升序；同 `at` 行为在前、Step 在后；
 * 同源按 id 稳定排序；不修改输入、不产生新事实。
 */
export function projectBehaviorTimeline(
    steps: readonly StepView[],
    behaviors: readonly UserBehaviorView[],
): TimelineEntry[] {
    const entries: TimelineEntry[] = [
        ...behaviors.map(
            (behavior): TimelineEntry => ({ source: 'behavior', at: behavior.ts, behavior }),
        ),
        ...steps.map((step): TimelineEntry => ({ source: 'step', at: step.startedAt, step })),
    ];
    return entries.sort(compareTimelineEntries);
}

function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
    if (a.at !== b.at) return a.at - b.at;
    if (a.source !== b.source) return a.source === 'behavior' ? -1 : 1;
    if (a.source === 'behavior' && b.source === 'behavior') return a.behavior.ts - b.behavior.ts;
    if (a.source === 'step' && b.source === 'step') {
        return a.step.stepId < b.step.stepId ? -1 : a.step.stepId > b.step.stepId ? 1 : 0;
    }
    return 0;
}
