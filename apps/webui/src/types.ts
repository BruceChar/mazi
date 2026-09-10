/** Shared domain types for the webui layer. */

export interface GoalRunRef {
    rootGoalId: string;
    input: string;
    createdAt: number;
}

export interface Conversation {
    conversationId: string;
    title: string;
    userId?: string;
    runs: GoalRunRef[];
    workspace?: string;
    projectId?: string;
    createdAt: number;
    updatedAt: number;
    archived?: boolean;
}

export interface Project {
    title: string;
    path: string;
}

export interface ProviderModel {
    id: string;
    name?: string;
}

export interface Provider {
    id: string;
    vendor?: string;
    models?: ProviderModel[];
}

export interface ConfigOverview {
    home: string;
    providers: Provider[];
    hasProvidersFile: boolean;
}

export interface StepUsage {
    vendor?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        reasoningOutputTokens?: number;
    };
    runtime?: {
        totalContextTokens?: number;
    };
}

export interface StepRow {
    key: string;
    stepId: string;
    goalId: string;
    taskId: string;
    at?: number;
    time: string;
    kind: string;
    kindLabel: string;
    status?: string;
    toolName: string;
    text: string;
    durationMs?: number;
    duration: string;
    usage?: StepUsage;
}

export interface TaskNode {
    taskId: string;
    title: string;
    status?: string;
    steps: StepRow[];
}

export interface GoalNode {
    goalId: string;
    statement: string;
    status?: string;
    tasks: TaskNode[];
}

export interface TimelineDetail {
    goals?: Array<{
        goalId: string;
        statement: string;
        status?: string;
        tasks?: Array<{
            taskId: string;
            title: string;
            status?: string;
            steps?: Array<{
                stepId: string;
                goalId: string;
                taskId: string;
                kind: string;
                status?: string;
                toolName?: string;
                content?: string;
                payloadText?: string;
                startedAt?: number;
                endedAt?: number;
                usage?: StepUsage;
            }>;
        }>;
    }>;
}

export interface RunOutcome {
    ok: boolean;
    finalMessage: string;
    errorMessage: string;
    reason: string;
    taskCount: number;
}

export interface EventItem {
    eventId: string;
    type: string;
    [key: string]: unknown;
}

export interface UserPreferences {
    displayName: string;
    favoriteTools: string;
    codeStyle: string;
    responseStyle: string;
}
