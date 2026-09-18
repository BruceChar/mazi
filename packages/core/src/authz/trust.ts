/**
 * Trust anchor seam (V3 §7 floor 4).
 *
 * The TCB cannot prove itself: root keys, approver identity and audit integrity
 * are anchored outside the system. The decision log is append-only, signed and
 * chained; the head is periodically committed to an external anchor. Any chain
 * or anchor mismatch raises `AUDIT_TAMPER_SUSPECTED`.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { contentVersion, stableStringify } from './hash.js';

export interface Signer {
    readonly keyId: string;
    sign(payload: string): string;
    verify(payload: string, signature: string): boolean;
}

export class Ed25519Signer implements Signer {
    readonly keyId: string;
    readonly publicKeyPem: string;
    private readonly privateKeyPem: string;

    private constructor(keyId: string, privateKeyPem: string, publicKeyPem: string) {
        this.keyId = keyId;
        this.privateKeyPem = privateKeyPem;
        this.publicKeyPem = publicKeyPem;
    }

    static generate(keyId = 'root-1'): Ed25519Signer {
        const { privateKey, publicKey } = generateKeyPairSync('ed25519');
        return new Ed25519Signer(
            keyId,
            privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        );
    }

    sign(payload: string): string {
        return sign(
            null,
            Buffer.from(payload, 'utf8'),
            createPrivateKey(this.privateKeyPem),
        ).toString('base64');
    }

    verify(payload: string, signature: string): boolean {
        try {
            return verify(
                null,
                Buffer.from(payload, 'utf8'),
                createPublicKey(this.publicKeyPem),
                Buffer.from(signature, 'base64'),
            );
        } catch {
            return false;
        }
    }
}

export interface AuditAnchor {
    put(headHash: string): void | Promise<void>;
    get(): string | undefined | Promise<string | undefined>;
}

export interface DecisionLogRecord {
    seq: number;
    prevHash: string;
    payload: Record<string, unknown>;
    hash: string;
    keyId: string;
    signature: string;
}

export interface AuditVerification {
    ok: boolean;
    code?: 'AUDIT_TAMPER_SUSPECTED';
    reason?: string;
}

export const AUDIT_GENESIS = 'genesis';

function recordHash(seq: number, prevHash: string, payload: Record<string, unknown>): string {
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
            : (this.records[this.records.length - 1] as DecisionLogRecord).hash;
    }

    append(payload: Record<string, unknown>): DecisionLogRecord {
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
            if (record.hash !== recordHash(record.seq, record.prevHash, record.payload)) {
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
