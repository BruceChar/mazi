/**
 * Approval echo and summary (V3 §6.3, §7 floor 4).
 *
 * The system's responsibility is the generation of a truthful, concrete summary
 * — not the approver's interpretation. The summary must name the dataflow
 * sources and residue provenance that triggered the request.
 */

import { contentVersion, stableStringify } from './hash.js';

export interface ApprovalEcho {
    invocationId: string;
    tool: string;
    effectClass: string;
    targetAsset?: string;
    counterparty?: string;
    amount?: { currency: string; amount: number };
    /** Dataflow origins (the ledger sources that triggered the request). */
    dataflowSources?: readonly string[];
    /** Residue (taint) provenance. */
    taintProvenance?: readonly string[];
    /** Mandatory disclosure when an unenforced axis is approved. */
    enforcementGapDisclosure?: string;
}

/** Human-facing summary: names the concrete transaction, not the category. */
export function summarizeEcho(echo: ApprovalEcho): string {
    const lines = [
        `调用 ${echo.invocationId}（工具 ${echo.tool}，效果 ${echo.effectClass}）`,
        `目标资产：${echo.targetAsset ?? '未声明'}`,
        `交易对手：${echo.counterparty ?? '无'}`,
        `金额：${echo.amount ? `${echo.amount.amount} ${echo.amount.currency}` : '无'}`,
        `数据流来源：${(echo.dataflowSources ?? []).join('、') || '无'}`,
        `数据残留来源：${(echo.taintProvenance ?? []).join('、') || '无'}`,
    ];
    if (echo.enforcementGapDisclosure) {
        lines.push(`强制缺口披露：${echo.enforcementGapDisclosure}`);
    }
    return lines.join('\n');
}

/** Stable fingerprint of the echo; binds an approval to a concrete summary. */
export function hashEcho(echo: ApprovalEcho): string {
    return contentVersion(stableStringify(echo)).toString(16);
}
