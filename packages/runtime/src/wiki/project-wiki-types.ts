export type ProjectWikiClaimState = 'active' | 'stale' | 'missing' | 'retracted';
export type ProjectWikiClaimStatus = ProjectWikiClaimState;
export type ProjectWikiRetractionKind = 'forgotten' | 'corrected' | 'obsolete';

export interface ProjectWikiEvidence {
    file: string;
    oid: string;
    hint?: string;
    status?: Exclude<ProjectWikiClaimState, 'retracted'>;
}

export interface ProjectWikiClaim {
    id: string;
    text: string;
    status: ProjectWikiClaimState;
    evidence: ProjectWikiEvidence[];
    established: string;
    verified: string;
    retractedAt?: string;
    retractedReason?: string;
    retractionKind?: ProjectWikiRetractionKind;
    supersededBy?: string;
    supersedes?: string;
    claimOid?: string;
}

export interface ProjectWikiDoc {
    path: string;
    title: string;
    group: 'index' | 'overview' | 'state' | 'decisions' | 'lessons' | 'other';
    content: string;
}

export interface ProjectWikiCommit {
    hash: string;
    subject: string;
    committedAt: string;
}

export interface ProjectWikiSummary {
    documents: number;
    claims: number;
    active: number;
    stale: number;
    missing: number;
    retracted: number;
    forgotten: number;
}

export interface ProjectWikiRepository {
    root: string;
    wikiRoot: string;
    indexPath: string;
    index: string;
    docs: ProjectWikiDoc[];
    claims: ProjectWikiClaim[];
    summary: ProjectWikiSummary;
    latestCommit?: ProjectWikiCommit;
}

export interface ProjectWikiEvidenceInput {
    file: string;
    hint?: string;
}

export interface ProjectWikiClaimInput {
    id: string;
    text: string;
    evidence: ProjectWikiEvidenceInput[];
    claimOid?: boolean;
}

export interface ProjectWikiClaimUpdateInput {
    id: string;
    text?: string;
    evidence?: ProjectWikiEvidenceInput[];
    claimOid?: boolean;
}

export interface ProjectWikiClaimCorrectionInput {
    oldId: string;
    newId: string;
    text: string;
    evidence: ProjectWikiEvidenceInput[];
    reason: string;
    claimOid?: boolean;
}

export interface ProjectWikiClaimForgetInput {
    id: string;
    reason: string;
}

export interface ProjectWikiVerificationFinding {
    level: 'STALE' | 'MISSING';
    claimId: string;
    message: string;
}

export interface ProjectWikiDoctorReport {
    root: string;
    claims: number;
    active: number;
    stale: number;
    missing: number;
    retracted: number;
    findings: ProjectWikiVerificationFinding[];
    warnings: string[];
}

export interface ProjectWikiUpdateClaim {
    id: string;
    text: string;
    detail: string;
    evidence: Array<{
        file: string;
        status: Exclude<ProjectWikiClaimState, 'retracted'>;
    }>;
}

export interface ProjectWikiUpdatePlan {
    checkpoint: string | null;
    changed_files: string[];
    claims: ProjectWikiUpdateClaim[];
    no_changes: boolean;
    needs_semantic_update: boolean;
}

export interface ProjectWikiActivityInput {
    input: string;
    status: 'success' | 'failed' | 'aborted';
    summary?: string;
}

export interface ProjectWikiActivity extends ProjectWikiActivityInput {
    at: string;
    statusLabel: string;
}

export interface ProjectWikiSessionEndResult extends ProjectWikiUpdatePlan {
    activity: ProjectWikiActivity;
}

export interface ProjectWikiOperationResult {
    ok: boolean;
    message: string;
    commit?: string;
}
