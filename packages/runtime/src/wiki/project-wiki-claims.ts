import { createHash } from 'node:crypto';

import type {
    ProjectWikiClaim,
    ProjectWikiClaimState,
    ProjectWikiEvidenceInput,
    ProjectWikiRetractionKind,
} from './project-wiki-types.js';

export const PROJECT_WIKI_CLAIMS_HEADER = [
    '# wiki/claims.toml — 只通过 runtime Project Wiki API 修改，禁止手改',
    '# status 落盘仅 active|retracted；stale/missing 由 doctor 运行时推导',
].join('\n');

export function escapeTomlString(value: string): string {
    return JSON.stringify(value);
}

export function serializeProjectWikiClaims(claims: ReadonlyMap<string, ProjectWikiClaim>): string {
    const lines = [PROJECT_WIKI_CLAIMS_HEADER, ''];
    for (const [id, claim] of claims) {
        lines.push(`[claims.${id}]`);
        lines.push(`text = ${escapeTomlString(claim.text)}`);
        lines.push(
            `status = ${escapeTomlString(claim.status === 'retracted' ? 'retracted' : 'active')}`,
        );
        if (claim.evidence.length === 0) {
            lines.push('evidence = []');
        } else {
            lines.push('evidence = [');
            for (const evidence of claim.evidence) {
                const parts = [`file = ${escapeTomlString(evidence.file)}`];
                if (evidence.hint) parts.push(`hint = ${escapeTomlString(evidence.hint)}`);
                parts.push(`oid = ${escapeTomlString(evidence.oid)}`);
                lines.push(`  { ${parts.join(', ')} },`);
            }
            lines.push(']');
        }
        lines.push(`established = ${claim.established}`);
        lines.push(`verified = ${claim.verified}`);
        if (claim.retractedAt) lines.push(`retracted_at = ${claim.retractedAt}`);
        if (claim.retractedReason) {
            lines.push(`retracted_reason = ${escapeTomlString(claim.retractedReason)}`);
        }
        if (claim.retractionKind) {
            lines.push(`retraction_kind = ${escapeTomlString(claim.retractionKind)}`);
        }
        if (claim.supersededBy) {
            lines.push(`superseded_by = ${escapeTomlString(claim.supersededBy)}`);
        }
        if (claim.supersedes) lines.push(`supersedes = ${escapeTomlString(claim.supersedes)}`);
        if (claim.claimOid) lines.push(`claim_oid = ${escapeTomlString(claim.claimOid)}`);
        lines.push('');
    }
    return lines.join('\n');
}

export function parseProjectWikiClaims(text: string): Map<string, ProjectWikiClaim> {
    const matches = [...text.matchAll(/^\[claims\.([^\]]+)\]\s*$/gm)];
    const claims = new Map<string, ProjectWikiClaim>();
    for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        if (!match) continue;
        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? text.length;
        const body = text.slice(start, end);
        const id = match[1] ?? '';
        const declared = tomlString(body, 'status') ?? 'active';
        const evidenceBlock = body.match(/^evidence\s*=\s*\[([\s\S]*?)^\]/m)?.[1] ?? '';
        const evidence = [...evidenceBlock.matchAll(/\{([\s\S]*?)\}/g)]
            .map((entry) => {
                const file = tomlString(entry[1] ?? '', 'file');
                const oid = tomlString(entry[1] ?? '', 'oid');
                if (!file || !oid) return undefined;
                const hint = tomlString(entry[1] ?? '', 'hint');
                return { file, oid, ...(hint ? { hint } : {}) };
            })
            .filter(
                (entry): entry is { file: string; oid: string; hint?: string } =>
                    entry !== undefined,
            );
        const claim: ProjectWikiClaim = {
            id,
            text: tomlString(body, 'text') ?? '',
            status: declared === 'retracted' ? 'retracted' : 'active',
            evidence,
            established: tomlDate(body, 'established') ?? '1970-01-01',
            verified: tomlDate(body, 'verified') ?? '1970-01-01',
        };
        const retractedAt = tomlDate(body, 'retracted_at');
        const retractedReason = tomlString(body, 'retracted_reason');
        const retractionKind = tomlString(body, 'retraction_kind');
        const supersededBy = tomlString(body, 'superseded_by');
        const supersedes = tomlString(body, 'supersedes');
        const claimOid = tomlString(body, 'claim_oid');
        if (retractedAt) claim.retractedAt = retractedAt;
        if (retractedReason) claim.retractedReason = retractedReason;
        if (
            retractionKind === 'forgotten' ||
            retractionKind === 'corrected' ||
            retractionKind === 'obsolete'
        ) {
            claim.retractionKind = retractionKind as ProjectWikiRetractionKind;
        }
        if (supersededBy) claim.supersededBy = supersededBy;
        if (supersedes) claim.supersedes = supersedes;
        if (claimOid) claim.claimOid = claimOid;
        claims.set(id, claim);
    }
    return claims;
}

export function claimStatusFromEvidence(
    evidence: ReadonlyArray<{ status?: Exclude<ProjectWikiClaimState, 'retracted'> }>,
): Exclude<ProjectWikiClaimState, 'retracted'> {
    if (evidence.some((entry) => entry.status === 'missing')) return 'missing';
    if (evidence.some((entry) => entry.status === 'stale')) return 'stale';
    return 'active';
}

export function withResolvedEvidence(
    claim: ProjectWikiClaim,
    oidOf: (file: string) => string | undefined,
): ProjectWikiClaim {
    if (claim.status === 'retracted') return claim;
    const evidence = claim.evidence.map((entry) => {
        const actual = oidOf(entry.file);
        return {
            ...entry,
            status:
                actual === undefined
                    ? ('missing' as const)
                    : actual === entry.oid
                      ? ('active' as const)
                      : ('stale' as const),
        };
    });
    return {
        ...claim,
        status: claimStatusFromEvidence(evidence),
        evidence,
    };
}

export function computeProjectWikiClaimOid(claim: ProjectWikiClaim): string {
    const basis = [
        claim.text,
        ...claim.evidence.map((entry) => entry.oid),
        claim.status === 'retracted' ? 'retracted' : 'active',
        claim.verified,
    ].join('\u001f');
    return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export function normalizeProjectWikiClaimId(id: string): string {
    const value = id.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new Error('Project Wiki claim id 只允许 [A-Za-z0-9_-]');
    }
    return value;
}

export function normalizeEvidenceInputs(
    inputs: ReadonlyArray<ProjectWikiEvidenceInput>,
): ProjectWikiEvidenceInput[] {
    const seen = new Set<string>();
    const result: ProjectWikiEvidenceInput[] = [];
    for (const input of inputs) {
        const file = input.file.trim().replace(/\\/g, '/');
        if (file.length === 0 || seen.has(file)) continue;
        seen.add(file);
        result.push({ file, ...(input.hint?.trim() ? { hint: input.hint.trim() } : {}) });
    }
    return result;
}

function tomlString(body: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const value = body.match(
        new RegExp(`(?:^|[,\\n{])\\s*${escaped}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, 'm'),
    )?.[1];
    if (value === undefined) return undefined;
    try {
        return JSON.parse(`"${value}"`) as string;
    } catch {
        return value;
    }
}

function tomlDate(body: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return body.match(new RegExp(`^${escaped}\\s*=\\s*([^\\s#]+)`, 'm'))?.[1];
}
