import type {
    PromptMatchResult,
    PromptRiskLevel,
    PromptTaskKind,
} from '../prompts/types.js';

export interface SuperAgentInput {
    userId?: string;
    projectId?: string;
    workspace?: string;
    input: string;
    tools?: readonly string[];
    riskLevel?: PromptRiskLevel;
    projectTags?: readonly string[];
    explicitPackIds?: readonly string[];
}

export interface SuperAgentMemoryPlan {
    readUser: boolean;
    readProject: boolean;
    writeEpisode: boolean;
}

export interface SuperAgentDecision {
    userId?: string;
    projectId?: string;
    workspace?: string;
    taskKind: PromptTaskKind;
    riskLevel: PromptRiskLevel;
    promptPackIds: string[];
    plannerId: 'task-graph';
    verifierId: 'independent-default';
    memoryPlan: SuperAgentMemoryPlan;
    blackboardRequired: boolean;
    promptMatch: PromptMatchResult;
    reason: string[];
}
