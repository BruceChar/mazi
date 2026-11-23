import type { PlannedTask } from '../gts/plan-graph.js';
import type { TaskPlannerHistoryEntry } from '../gts/task-planner.js';

/**
 * 单轮"输入侧"状态（create → execute 之间传递，docs §4 迁移表）。
 *
 * 这些 Map 都以 rootGoalId 为键、在 executeGoalTreeBody 消费后立即删除；
 * 抽成独立类是为了让 HarnessRuntime 只保留"编排"，不再承载会话态字段。
 * 生命周期与 Goal 执行同进程，因此无需清理钩子（消费即删，Goal 结束后不再有键）。
 */
export class SessionIntake {
    /** 待执行 Session 的 Conversation id（session 作用域审批匹配用） */
    readonly pendingSessionId = new Map<string, string>();
    readonly pendingReasoning = new Map<string, string>();
    readonly pendingModel = new Map<string, string>();
    readonly pendingPromptFragment = new Map<string, string>();
    readonly pendingSkills = new Map<string, readonly string[]>();
    readonly pendingAllowedTools = new Map<string, readonly string[]>();
    readonly pendingPlanProposal = new Map<string, readonly PlannedTask[]>();
    readonly pendingTaskPlanning = new Map<string, boolean>();
    readonly pendingLoopMode = new Map<string, 'default' | 'dynamic'>();
    /** In-flight async triage for a freshly created session (planning must see the full contract). */
    readonly pendingTriage = new Map<string, Promise<void>>();
    /** Conversation turns from the previous session, forwarded to the Task Planner. */
    readonly pendingHistory = new Map<string, readonly TaskPlannerHistoryEntry[]>();
    readonly pendingPromptPackIds = new Map<string, readonly string[]>();
    readonly pendingDelegationDepth = new Map<string, number>();
    readonly pendingMemoryContext = new Map<
        string,
        {
            conversationId?: string;
            userId?: string;
            workspaceId?: string;
            projectId?: string;
            /** 本次运行要求干净上下文：跳过黑板自动注入。 */
            fresh?: boolean;
        }
    >();
    /** 待执行 Session 的开关审计（flag.evaluated：值 + 求值痕迹） */
    readonly pendingFlags = new Map<
        string,
        {
            values: Record<string, boolean>;
            trace: Array<{ id: string; enabled: boolean; source: string }>;
        }
    >();

    /** Goal 被丢弃（取消/失败）时清空其输入侧残留。 */
    forget(rootGoalId: string): void {
        for (const map of [
            this.pendingSessionId,
            this.pendingReasoning,
            this.pendingModel,
            this.pendingPromptFragment,
            this.pendingSkills,
            this.pendingAllowedTools,
            this.pendingPlanProposal,
            this.pendingTaskPlanning,
            this.pendingLoopMode,
            this.pendingTriage,
            this.pendingHistory,
            this.pendingPromptPackIds,
            this.pendingDelegationDepth,
            this.pendingMemoryContext,
            this.pendingFlags,
        ]) {
            map.delete(rootGoalId);
        }
    }
}
