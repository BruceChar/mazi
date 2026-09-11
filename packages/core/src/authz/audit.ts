/**
 * Decision log — append-only signed hash chain with checkpoints and an
 * external anchor (§9.5.3, §11).
 *
 * A gateway-local signing subkey keeps every record signed without HSM
 * throughput limits; the head is periodically anchored externally. Any chain
 * or anchor mismatch raises `AUDIT_TAMPER_SUSPECTED`. Residual risk: a
 * compromised gateway can forge records within the most recent checkpoint
 * window — declared, not repaired.
 */

import { contentVersion, stableStringify } from './hash.js';
import type { Signer } from './root-trust.js';

export interface DecisionEvent {
    type: string;
    [key: string]: unknown;
}

export interface DecisionLogRecord {
    seq: number;
    prevHash: string;
    payload: DecisionEvent;
    hash: string;
    keyId: string;
    signature: string;
}

export const AUDIT_GENESIS = 'genesis';

export interface AuditAnchor {
    put(headHash: string): void | Promise<void>;
    get(): string | undefined | Promise<string | undefined>;
}

export interface AuditVerification {
    ok: boolean;
    code?: 'AUDIT_TAMPER_SUSPECTED';
    reason?: string;
}

function recordHash(seq: number, prevHash: string, payload: DecisionEvent): string {
    return contentVersion(stableStringify({ seq, prevHash, payload })).toString(16);
}

export class DecisionLog {
    private readonly records: DecisionLogRecord[] = [];

    constructor(
        private readonly signer: Signer,
        private readonly anchor?: AuditAnchor,
    ) {}

    head(): string {
        return this.records.length === 0
            ? AUDIT_GENESIS
            : this.records[this.records.length - 1].hash;
    }

    append(payload: DecisionEvent): DecisionLogRecord {
        const seq = this.records.length + 1;
        const prevHash = this.head();
        const hash = recordHash(seq, prevHash, payload);
        const record: DecisionLogRecord = {
            seq,
            prevHash,
            payload,
            hash,
            keyId: this.signer.keyId,
            signature: this.signer.sign(hash),
        };
        this.records.push(record);
        return record;
    }

    all(): readonly DecisionLogRecord[] {
        return this.records;
    }

    verify(): AuditVerification {
        let previous = AUDIT_GENESIS;
        for (const record of this.records) {
            if (record.prevHash !== previous) {
                return {
                    ok: false,
                    code: 'AUDIT_TAMPER_SUSPECTED',
                    reason: `prevHash 断链（seq=${record.seq}）`,
                };
            }
            const expected = recordHash(record.seq, record.prevHash, record.payload);
            if (record.hash !== expected) {
                return {
                    ok: false,
                    code: 'AUDIT_TAMPER_SUSPECTED',
                    reason: `记录哈希不符（seq=${record.seq}）`,
                };
            }
            if (
                record.keyId !== this.signer.keyId ||
                !this.signer.verify(record.hash, record.signature)
            ) {
                return {
                    ok: false,
                    code: 'AUDIT_TAMPER_SUSPECTED',
                    reason: `签名无效（seq=${record.seq}）`,
                };
            }
            previous = record.hash;
        }
        return { ok: true };
    }

    /** Checkpoint the head to the external root-trust anchor. */
    async checkpoint(): Promise<string> {
        const head = this.head();
        if (this.anchor) await this.anchor.put(head);
        return head;
    }

    async verifyAgainstAnchor(): Promise<AuditVerification> {
        const chain = this.verify();
        if (!chain.ok) return chain;
        if (!this.anchor) return { ok: true };
        const anchored = await this.anchor.get();
        if (anchored !== undefined && anchored !== this.head()) {
            return { ok: false, code: 'AUDIT_TAMPER_SUSPECTED', reason: '外部锚点与链头不一致' };
        }
        return { ok: true };
    }
}
