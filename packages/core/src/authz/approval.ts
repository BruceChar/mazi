/**
 * Approval seam contract values (§9.5.2, §12, V18/T8).
 *
 * The system's responsibility is the generation and signing of the structured
 * summary — not the approver's interpretation. Approval tokens are short-lived
 * and bound to a concrete invocationId + summary hash, so an approval can
 * never be replaced by a generalized consent.
 */

import { contentVersion, stableStringify } from './hash.js';
import type { Signer } from './root-trust.js';
import type { Money } from './types.js';

export const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000;

export type GenerationAttestationOption = 'once' | 'generation-attestation' | 'reject';

export interface ApprovalEcho {
    invocationId: string;
    tool: string;
    effectClass: string;
    targetAsset?: string;
    counterparty?: string;
    amount?: Money;
    /** Data-flow origins (T8: dataflow sources must be shown). */
    dataflowSources?: readonly string[];
    /** Derived-label residue provenance (T8). */
    derivedLabelProvenance?: readonly string[];
    /** V15 gated-axis disclosure (mandatory when an unenforced axis is approved). */
    enforcementGapDisclosure?: string;
    /** A2b generation-level informed-attestation text. */
    generationAttestationText?: string;
    generationAttestationOptions?: readonly GenerationAttestationOption[];
}

/** V18: human-facing, must name the concrete transaction, not the category. */
export function summarizeEcho(echo: ApprovalEcho): string {
    const lines = [
        `调用 ${echo.invocationId}（工具 ${echo.tool}，效果 ${echo.effectClass}）`,
        `目标资产：${echo.targetAsset ?? '未声明'}`,
        `交易对手：${echo.counterparty ?? '无'}`,
        `金额：${echo.amount ? `${echo.amount.amount} ${echo.amount.currency}` : '无'}`,
        `数据流来源：${(echo.dataflowSources ?? []).join('、') || '无'}`,
        `数据残留来源：${(echo.derivedLabelProvenance ?? []).join('、') || '无'}`,
    ];
    if (echo.enforcementGapDisclosure) {
        lines.push(`强制缺口披露：${echo.enforcementGapDisclosure}`);
    }
    if (echo.generationAttestationText) {
        lines.push(`世代级知情豁免：${echo.generationAttestationText}`);
    }
    return lines.join('\n');
}

export function hashEcho(echo: ApprovalEcho): string {
    return contentVersion(stableStringify(echo)).toString(16);
}

export interface ApprovalToken {
    invocationId: string;
    summaryHash: string;
    attestor: string;
    issuedAt: number;
    expiresAt: number;
    keyId: string;
    signature: string;
}

function tokenPayload(token: Omit<ApprovalToken, 'signature' | 'keyId'>): string {
    return `${token.invocationId}:${token.summaryHash}:${token.attestor}:${token.issuedAt}:${token.expiresAt}`;
}

export function issueApprovalToken(
    echo: ApprovalEcho,
    attestor: string,
    signer: Signer,
    now: number,
    ttl = APPROVAL_TOKEN_TTL_MS,
): ApprovalToken {
    const unsigned = {
        invocationId: echo.invocationId,
        summaryHash: hashEcho(echo),
        attestor,
        issuedAt: now,
        expiresAt: now + Math.min(ttl, APPROVAL_TOKEN_TTL_MS),
    };
    return {
        ...unsigned,
        keyId: signer.keyId,
        signature: signer.sign(tokenPayload(unsigned)),
    };
}

export function verifyApprovalToken(
    token: ApprovalToken,
    echo: ApprovalEcho,
    verifier: Signer,
    now: number,
): boolean {
    if (token.invocationId !== echo.invocationId) return false;
    if (token.summaryHash !== hashEcho(echo)) return false;
    if (now >= token.expiresAt) return false;
    if (verifier.keyId !== token.keyId) return false;
    return verifier.verify(tokenPayload(token), token.signature);
}

export type HighRiskOperation =
    | 'pay-over-limit'
    | 'boundary-write'
    | 'l3-exception'
    | 'secret-downgrade';

/**
 * High-risk operations default to two-person sign-off; a single approver
 * requires an explicit root-layer downgrade (§9.5.2).
 */
export function requiresDualApproval(
    operation: HighRiskOperation,
    opts: { rootDowngrade?: boolean } = {},
): boolean {
    if (opts.rootDowngrade === true) return false;
    return (
        operation === 'pay-over-limit' ||
        operation === 'boundary-write' ||
        operation === 'l3-exception' ||
        operation === 'secret-downgrade'
    );
}
