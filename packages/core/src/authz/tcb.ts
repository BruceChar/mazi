/**
 * TCB versioning and scope (§9.4 T1/T2/T6, N10).
 *
 * Registries carry a content hash + version; every derived snapshot pins the
 * versions it used so a decision can be attributed to an exact TCB revision.
 * A pinned snapshot is immutable for the life of a running task (T6).
 */

import { contentVersion } from './hash.js';
import type { AssetLabelRegistry } from './labels.js';
import type { RoleRegistry } from './roles.js';
import type { PinnedVersions } from './types.js';

export interface TcbComponent {
    id: 'labels' | 'roles' | 'rules' | 'rootTrust';
    version: number;
    contentHash: string;
}

export interface TcbState {
    labels: AssetLabelRegistry;
    roles: RoleRegistry;
    rules: unknown;
    rootTrustVersion: number;
}

/** T2: the harness self-envelope is itself a boundary asset (R5). */
export const TCB_SELF_REFERENCE_PATTERNS: readonly string[] = [
    '~/.mazi/**',
    '**/.mazi/**',
    '**/grant-store*',
    '**/policy.json',
    '**/tool-registry*',
    '**/authz/**',
    '**/authz.config*',
] as const;

export class TcbManifest {
    readonly components: readonly TcbComponent[];
    readonly version: number;

    constructor(components: readonly TcbComponent[]) {
        this.components = [...components];
        this.version = contentVersion(this.components);
    }

    static fromState(state: TcbState): TcbManifest {
        return new TcbManifest([
            {
                id: 'labels',
                version: state.labels.version,
                contentHash: String(state.labels.version),
            },
            { id: 'roles', version: state.roles.version, contentHash: String(state.roles.version) },
            {
                id: 'rules',
                version: contentVersion(state.rules),
                contentHash: String(contentVersion(state.rules)),
            },
            {
                id: 'rootTrust',
                version: state.rootTrustVersion,
                contentHash: String(state.rootTrustVersion),
            },
        ]);
    }

    pinned(): PinnedVersions {
        const find = (id: TcbComponent['id']): number =>
            this.components.find((c) => c.id === id)?.version ?? 0;
        return {
            labels: find('labels'),
            roles: find('roles'),
            rules: find('rules'),
            rootTrust: find('rootTrust'),
        };
    }
}

export function buildPinned(input: {
    labels: number;
    roles: number;
    rules: number;
    rootTrust: number;
}): PinnedVersions {
    return { ...input };
}

/**
 * T6: a running task keeps its pinned snapshot; a registry/rule change never
 * hot-swaps it. The change must go through a new ContractRevision.
 */
export function assertSnapshotImmutable(pinned: PinnedVersions, current: PinnedVersions): void {
    if (contentVersion(pinned) !== contentVersion(current)) {
        throw new Error(
            `运行中任务的钉版快照不可热改：pinned=${JSON.stringify(pinned)} current=${JSON.stringify(current)}`,
        );
    }
}
