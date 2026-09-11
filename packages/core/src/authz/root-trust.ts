/**
 * Root trust anchor — Ed25519 root signatures, key rotation and the policy
 * revocation registry (§9.5, N10).
 *
 * The TCB cannot prove itself: root signatures, the approver identity, audit
 * integrity and revocation are supported by this anchor, which lives outside
 * the TCB. Private keys never enter the agent runtime process in production;
 * the software signer here is a deployment seam (HSM/KMS/OS keychain).
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { contentVersion, stableStringify } from './hash.js';
import type { PinnedVersions } from './types.js';

export interface Signer {
    readonly keyId: string;
    sign(payload: string): string;
    verify(payload: string, signature: string): boolean;
}

export class Ed25519Signer implements Signer {
    readonly keyId: string;
    private readonly privateKeyPem: string;
    readonly publicKeyPem: string;

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

    /** A verifier-only view for the anchor (rotated old keys verify old tasks). */
    asVerifier(): { keyId: string; publicKeyPem: string } {
        return { keyId: this.keyId, publicKeyPem: this.publicKeyPem };
    }
}

export interface RootKey {
    keyId: string;
    publicKeyPem: string;
    validFromVersion: number;
    retiredAtVersion?: number;
}

/**
 * Verifies signatures against a versioned key set; a snapshot pins
 * `rootTrust@v` so a running task keeps verifying with the keys current at
 * derive time even across rotation (§9.5.1).
 */
export class RootTrustAnchor {
    private readonly keys: RootKey[] = [];

    addKey(key: RootKey): void {
        this.keys.push(key);
    }

    register(signer: Ed25519Signer, validFromVersion = 1): void {
        this.addKey({ ...signer.asVerifier(), validFromVersion });
    }

    rotate(signer: Ed25519Signer, validFromVersion: number, previousKeyId: string): void {
        for (const key of this.keys) {
            if (key.keyId === previousKeyId && key.retiredAtVersion === undefined) {
                key.retiredAtVersion = validFromVersion;
            }
        }
        this.register(signer, validFromVersion);
    }

    version(): number {
        return this.keys.length === 0 ? 0 : Math.max(...this.keys.map((k) => k.validFromVersion));
    }

    keysAt(version: number): RootKey[] {
        return this.keys.filter(
            (key) =>
                key.validFromVersion <= version &&
                (key.retiredAtVersion === undefined || key.retiredAtVersion > version),
        );
    }

    verify(keyId: string, payload: string, signature: string, atVersion?: number): boolean {
        const candidates = atVersion === undefined ? this.keys : this.keysAt(atVersion);
        const key = candidates.find((k) => k.keyId === keyId);
        if (!key) return false;
        try {
            return verify(
                null,
                Buffer.from(payload, 'utf8'),
                createPublicKey(key.publicKeyPem),
                Buffer.from(signature, 'base64'),
            );
        } catch {
            return false;
        }
    }
}

// ============================================================
// Policy revocation registry (§9.5.4)
// ============================================================

export interface RevocationEntry {
    targetVersion: string;
    reason: string;
    issuedAt: number;
    keyId: string;
    signature: string;
}

export function pinnedHash(pinned: PinnedVersions): string {
    return contentVersion(stableStringify(pinned)).toString(16);
}

export function pinnedTokens(pinned: PinnedVersions): string[] {
    return [
        pinnedHash(pinned),
        `labels@${pinned.labels}`,
        `roles@${pinned.roles}`,
        `rules@${pinned.rules}`,
        `rootTrust@${pinned.rootTrust}`,
    ];
}

/**
 * The revocation registry is root-signed and externally anchored. An emergency
 * revocation makes callers fail closed on the pinned old snapshot
 * (`POLICY_REVOKED`); new tasks use the new version.
 */
export class RevocationRegistry {
    private readonly entries: RevocationEntry[] = [];

    constructor(
        private readonly anchor: RootTrustAnchor,
        private readonly signer: Signer,
        private readonly now: () => number = () => Date.now(),
    ) {}

    revoke(targetVersion: string, reason: string): RevocationEntry {
        const issuedAt = this.now();
        const entry: RevocationEntry = {
            targetVersion,
            reason,
            issuedAt,
            keyId: this.signer.keyId,
            signature: this.signer.sign(`${targetVersion}:${reason}:${issuedAt}`),
        };
        this.entries.push(entry);
        return entry;
    }

    all(): readonly RevocationEntry[] {
        return this.entries;
    }

    /** A revoked component or snapshot hash makes the pinned snapshot fail closed. */
    isRevoked(pinned: PinnedVersions): boolean {
        const tokens = new Set(pinnedTokens(pinned));
        return this.entries.some((entry) => tokens.has(entry.targetVersion));
    }

    verifyEntry(entry: RevocationEntry, atVersion?: number): boolean {
        return this.anchor.verify(
            entry.keyId,
            `${entry.targetVersion}:${entry.reason}:${entry.issuedAt}`,
            entry.signature,
            atVersion,
        );
    }
}
