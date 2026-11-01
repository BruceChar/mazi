export type PromptTaskKind =
    | 'general'
    | 'coding'
    | 'debug'
    | 'research'
    | 'data'
    | 'memory'
    | 'security';

export type PromptRiskLevel = 'read-only' | 'workspace-write' | 'external' | 'irreversible';

export interface PromptPackMatcher {
    projectIds?: readonly string[];
    projectTags?: readonly string[];
    taskKinds?: readonly PromptTaskKind[];
    toolNeeds?: readonly string[];
    riskLevels?: readonly PromptRiskLevel[];
}

export interface PromptPack {
    id: string;
    name: string;
    description: string;
    version: number;
    priority?: number;
    enabled?: boolean;
    matcher: PromptPackMatcher;
    module: string;
    projectRules?: readonly string[];
    examples?: readonly string[];
    budgetTokens?: number;
    conflictsWith?: readonly string[];
    evalBaselineRef?: string;
}

export interface PromptMatchContext {
    projectId?: string;
    projectTags?: readonly string[];
    taskKind: PromptTaskKind;
    input: string;
    tools?: readonly string[];
    riskLevel?: PromptRiskLevel;
    explicitPackIds?: readonly string[];
}

export interface PromptPackTrace {
    packId: string;
    version: number;
    score: number;
    reasons: string[];
}

export interface PromptMatchResult {
    corePrompt: string;
    index: string;
    selected: PromptPack[];
    prompt: string;
    trace: PromptPackTrace[];
    estimatedTokens: number;
}

export interface PromptPackStore {
    load(): readonly PromptPack[];
    save(pack: PromptPack): void;
    close(): void;
}
