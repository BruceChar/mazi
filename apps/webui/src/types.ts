/**
 * UI-layer types. Shared API contracts (Conversation, Project, ProviderOverview,
 * GoalTreeSnapshot, EventItem, etc.) are imported from @mazi/libs; this file
 * only holds UI-specific derived types and local state shapes.
 */
import type {
    Conversation,
    EventItem,
    GoalNodeView,
    GoalRunRef,
    GoalTreeSnapshot,
    Project,
    ProviderModel,
    ProviderOverview,
    StepView,
    TaskNodeView,
} from '@mazi/libs';

// Re-export shared types for convenience within the webui package.
export type {
    Conversation,
    EventItem,
    GoalNodeView,
    GoalRunRef,
    GoalTreeSnapshot,
    Project,
    ProviderModel,
    ProviderOverview,
    StepView,
    TaskNodeView,
};

/** GET /api/config response (re-exported from libs as ConfigOverview). */
export type { ConfigOverview } from '@mazi/libs';

// ============================================================
// UI-derived types (not part of the API contract)
// ============================================================

/** A flattened step row for timeline rendering (includes goal/task context). */
export interface StepRow extends StepView {
    goalId: string;
    taskId: string;
    goalStatement: string;
    taskTitle: string;
    goalIndex: number;
    taskIndex: number;
    stepIndex: number;
}

/** UI task node (wraps libs TaskNodeView with display metadata). */
export interface TaskNode extends TaskNodeView {
    goalId: string;
    goalStatement: string;
    goalIndex: number;
    taskIndex: number;
}

/** UI goal node (wraps libs GoalNodeView with display metadata). */
export interface GoalNode extends GoalNodeView {
    goalIndex: number;
}

/** Per-run outcome stored in memory (POST /api/sessions/:id/run response summary). */
export interface RunOutcome {
    ok: boolean;
    finalMessage: string;
    errorMessage: string;
    reason: string;
    taskCount: number;
}

/** Local user preferences (stored in localStorage). */
export interface UserPreferences {
    displayName: string;
    favoriteTools: string;
    codeStyle: string;
    responseStyle: string;
}
