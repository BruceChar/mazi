/**
 * Shared API contracts between apps/api (server) and apps/webui (client).
 * These types define the wire format of REST/SSE responses and must stay
 * in sync with the serialization shape produced by the server.
 */

// ============================================================
// Conversation domain (apps/api conversations.service)
// ============================================================

/** A single Goal run reference inside a Conversation. */
export interface GoalRunRef {
    rootGoalId: string;
    /** Intake Goal statement (raw user input). */
    input: string;
    createdAt: number;
}

/** Conversation business object returned by the API. */
export interface Conversation {
    conversationId: string;
    title: string;
    userId?: string;
    runs: GoalRunRef[];
    /** Workspace root path; always paired with projectId. */
    workspace?: string;
    /** Project identifier within the workspace; always paired with workspace. */
    projectId?: string;
    createdAt: number;
    updatedAt: number;
    /** When true, hidden from the active list but recoverable. */
    archived?: boolean;
}

// ============================================================
// Workspace / project configuration
// ============================================================

/** A registered workspace project (from workspaces.json). */
export interface Project {
    title: string;
    path: string;
}

// ============================================================
// Provider / model configuration (GET /api/config)
// ============================================================

export interface ProviderModel {
    id: string;
    name?: string;
}

/** Provider overview returned by configOverview(). */
export interface ProviderOverview {
    id: string;
    vendor?: string;
    models: ProviderModel[];
}

/** GET /api/config response. */
export interface ConfigOverview {
    home: string;
    providers: ProviderOverview[];
    hasProvidersFile: boolean;
}

// ============================================================
// Goal tree snapshot (GET /api/sessions/:id/timeline)
// ============================================================

/** Step kind (aligned with core StepKind). */
export type SnapshotStepKind = 'thinking' | 'intent' | 'tool_call' | 'observation';

/** Token usage attached to a step (vendor + runtime dimensions). */
export interface StepUsage {
    vendor?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        reasoningOutputTokens?: number;
    };
    runtime?: {
        totalContextTokens: number;
        systemPromptTokens: number;
        historyTokens: number;
        toolSchemaTokens: number;
        newInputTokens: number;
        observationTokens: number;
        estimationDriftTokens?: number;
    };
}

/** A single step in the goal-tree snapshot. */
export interface StepView {
    stepId: string;
    goalId: string;
    taskId: string;
    kind: SnapshotStepKind;
    status: string;
    startedAt: number;
    endedAt?: number;
    /** Full payload content (thinking/intent text, tool output). */
    content?: string;
    /** Tool name (for tool_call steps). */
    toolName?: string;
    /** Payload summary (≤240 chars) for audit/log display. */
    payloadText?: string;
    /** Token usage (vendor + runtime). */
    usage?: StepUsage;
}

/** A task node in the goal-tree snapshot. */
export interface TaskNodeView {
    taskId: string;
    status: string;
    title: string;
    steps: StepView[];
}

/** A goal node in the goal-tree snapshot. */
export interface GoalNodeView {
    goalId: string;
    kind: 'intake' | 'work';
    status: string;
    statement: string;
    tasks: TaskNodeView[];
}

/** Full goal-tree snapshot returned by GET /api/sessions/:id/timeline. */
export interface GoalTreeSnapshot {
    rootGoalId: string;
    goals: GoalNodeView[];
    taskCount: number;
    stepCount: number;
}

// ============================================================
// Events (SSE /api/events/:id)
// ============================================================

/** A single event item from the event stream or history. */
export interface EventItem {
    eventId: string;
    type: string;
    [key: string]: unknown;
}
