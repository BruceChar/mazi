import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export type BlackboardSection =
    | 'summary'
    | 'architecture'
    | 'status'
    | 'issues'
    | 'decisions'
    | 'all';

export interface BlackboardEvidence {
    kind: 'file' | 'git' | 'test' | 'goal' | 'session';
    ref: string;
    note?: string;
    verifiedAt?: number;
}

export interface ProjectBlackboard {
    projectId: string;
    workspaceRef: string;
    name: string;
    purpose: string;
    status: 'active' | 'paused' | 'completed' | 'blocked';
    architectureSummary: string;
    stack: string[];
    coreModules: string[];
    interfaces: string[];
    constraints: string[];
    activeGoals: string[];
    completedMilestones: string[];
    knownIssues: string[];
    decisions: string[];
    nextActions: string[];
    recentChanges: string[];
    evidenceRefs: BlackboardEvidence[];
    lastVerifiedAt: number;
    sourceFingerprint: string;
    version: number;
    updatedAt: number;
}

export interface BlackboardRunUpdate {
    rootGoalId: string;
    statement: string;
    ok: boolean;
    reason: string;
    finalMessage?: string;
    taskTitles: string[];
    changedPaths?: string[];
    now?: number;
}

export function projectIdForWorkspace(workspace: string): string {
    return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16);
}
