/**
 * AssetLabel registry — sensitivity and boundary annotations.
 *
 * Fail-safe defaults: an unannotated asset is `internal`; an annotation in doubt
 * is `sensitive`. The conservative direction is not configurable. Platform
 * curated negative entries are the low-cost outlet for known-safe patterns
 * (e.g. `*.pub.pem`, `.env.example`), cancelling broader positive declarations.
 */

import { isInsidePath, matchGlob, normalizeAssetPath, specificityOf } from './glob.js';
import { contentVersion } from './hash.js';
import { LABEL_RANK, type SensitivityLabel } from './types.js';

export type AssetKind = 'path' | 'env' | 'host' | 'db';
export type LabelOrigin = 'platform' | 'user' | 'platform-curated-negative';

export interface AssetLabel {
    kind: AssetKind;
    /** Glob / FQN / domain wildcard. */
    pattern: string;
    label: SensitivityLabel;
    /** Permission-envelope asset → Q3 on write. */
    boundary?: boolean;
    /** Pattern concreteness: count of non-wildcard characters. */
    specificity?: number;
    origin: LabelOrigin;
}

export interface AssetQuery {
    kind: AssetKind;
    value: string;
}

export interface ResolvedLabel {
    label: SensitivityLabel;
    boundary: boolean;
    specificity: number;
    matches: readonly AssetLabel[];
}

const HOME_USER_DATA_PATTERN = '~/**';

/** Platform annotations: secrets (sever on read / forbid on write), boundary assets, negative entries. */
export const BUILTIN_ASSET_LABELS: readonly AssetLabel[] = [
    // —— secrets ——
    { kind: 'path', pattern: '~/.ssh/**', label: 'secret', origin: 'platform' },
    { kind: 'path', pattern: '**/.env*', label: 'secret', origin: 'platform' },
    { kind: 'path', pattern: '**/*.pem', label: 'secret', origin: 'platform' },
    { kind: 'path', pattern: '**/id_rsa*', label: 'secret', origin: 'platform' },
    { kind: 'path', pattern: '**/credentials*', label: 'secret', origin: 'platform' },
    { kind: 'path', pattern: '**/Library/Keychains/**', label: 'secret', origin: 'platform' },
    { kind: 'path', pattern: '**/*.keychain*', label: 'secret', origin: 'platform' },
    { kind: 'env', pattern: 'AWS_*', label: 'secret', origin: 'platform' },
    { kind: 'env', pattern: '*_TOKEN', label: 'secret', origin: 'platform' },
    { kind: 'env', pattern: '*SECRET*', label: 'secret', origin: 'platform' },
    { kind: 'env', pattern: '*_PASSWORD', label: 'secret', origin: 'platform' },
    { kind: 'env', pattern: '*_API_KEY', label: 'secret', origin: 'platform' },

    // —— platform-curated negative entries ——
    {
        kind: 'path',
        pattern: '**/*.pub.pem',
        label: 'internal',
        origin: 'platform-curated-negative',
    },
    {
        kind: 'path',
        pattern: '**/ca-certificates/**',
        label: 'internal',
        origin: 'platform-curated-negative',
    },
    {
        kind: 'path',
        pattern: '**/chain.pem',
        label: 'internal',
        origin: 'platform-curated-negative',
    },
    {
        kind: 'path',
        pattern: '**/.env.example',
        label: 'internal',
        origin: 'platform-curated-negative',
    },
    {
        kind: 'path',
        pattern: '**/.env.template',
        label: 'internal',
        origin: 'platform-curated-negative',
    },
    {
        kind: 'path',
        pattern: '**/.env.sample',
        label: 'internal',
        origin: 'platform-curated-negative',
    },
    {
        kind: 'path',
        pattern: '**/id_rsa.pub',
        label: 'internal',
        origin: 'platform-curated-negative',
    },

    // —— system configuration: sensitive, boundary ——
    { kind: 'path', pattern: '/etc/**', label: 'sensitive', boundary: true, origin: 'platform' },
    { kind: 'path', pattern: '/usr/**', label: 'sensitive', boundary: true, origin: 'platform' },
    { kind: 'path', pattern: '/bin/**', label: 'sensitive', boundary: true, origin: 'platform' },
    { kind: 'path', pattern: '/System/**', label: 'sensitive', boundary: true, origin: 'platform' },

    // —— user data outside the workspace: sensitive ——
    { kind: 'path', pattern: HOME_USER_DATA_PATTERN, label: 'sensitive', origin: 'platform' },

    // —— boundary set: identity persistence ——
    {
        kind: 'path',
        pattern: '~/.ssh/authorized_keys',
        label: 'secret',
        boundary: true,
        origin: 'platform',
    },
    { kind: 'path', pattern: '~/.aws/**', label: 'secret', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '~/.config/gcloud/**',
        label: 'secret',
        boundary: true,
        origin: 'platform',
    },
    { kind: 'path', pattern: '~/.azure/**', label: 'secret', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '~/.kube/config',
        label: 'secret',
        boundary: true,
        origin: 'platform',
    },

    // —— boundary set: execution persistence ——
    {
        kind: 'path',
        pattern: '/etc/crontab',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '/var/spool/cron/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    { kind: 'path', pattern: '~/.crontab', label: 'sensitive', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '/etc/systemd/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '~/.config/systemd/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '~/.config/autostart/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },

    // —— boundary set: shell rc / profiles ——
    { kind: 'path', pattern: '~/.bashrc', label: 'sensitive', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '~/.bash_profile',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    { kind: 'path', pattern: '~/.zshrc', label: 'sensitive', boundary: true, origin: 'platform' },
    { kind: 'path', pattern: '~/.profile', label: 'sensitive', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '~/.config/fish/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },

    // —— boundary set: supply-chain hooks ——
    {
        kind: 'path',
        pattern: '**/.git/hooks/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '**/.husky/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '**/.pre-commit-config.yaml',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '**/.github/workflows/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '**/.gitlab-ci.yml',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '**/.circleci/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },

    // —— boundary set: tool-config persistence ——
    {
        kind: 'path',
        pattern: '~/.gitconfig',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '~/.config/git/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    { kind: 'path', pattern: '~/.npmrc', label: 'sensitive', boundary: true, origin: 'platform' },
    { kind: 'path', pattern: '~/.yarnrc', label: 'sensitive', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '~/.pip/pip.conf',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '~/.config/pip/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
    {
        kind: 'path',
        pattern: '~/.docker/config.json',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },

    // —— boundary set: harness self-envelope (TCB self-reference) ——
    { kind: 'path', pattern: '~/.mazi/**', label: 'sensitive', boundary: true, origin: 'platform' },
    {
        kind: 'path',
        pattern: '**/.mazi/**',
        label: 'sensitive',
        boundary: true,
        origin: 'platform',
    },
] as const;

export interface LabelRegistryOptions {
    home?: string;
    workspaceRoot?: string;
}

function normalizeLabel(label: AssetLabel): AssetLabel {
    return { ...label, specificity: label.specificity ?? specificityOf(label.pattern) };
}

function matches(label: AssetLabel, value: string, opts: LabelRegistryOptions): boolean {
    const pattern =
        label.kind === 'path' ? normalizeAssetPath(label.pattern, opts.home) : label.pattern;
    if (
        label.kind === 'path' &&
        label.pattern === HOME_USER_DATA_PATTERN &&
        opts.workspaceRoot &&
        isInsidePath(value, opts.workspaceRoot)
    ) {
        return false;
    }
    return matchGlob(pattern, value);
}

/**
 * Strictest label wins; platform negative entries cancel every positive
 * declaration they are at least as specific as; boundary is the union of the
 * surviving matches. A secret platform declaration is the highest label, so a
 * user declaration can never downgrade it.
 */
export function resolveLabel(
    query: AssetQuery,
    labels: readonly AssetLabel[],
    opts: LabelRegistryOptions = {},
): ResolvedLabel {
    const value = query.kind === 'path' ? normalizeAssetPath(query.value, opts.home) : query.value;
    const matched = labels
        .filter((label) => label.kind === query.kind && matches(label, value, opts))
        .map(normalizeLabel);

    const negatives = matched.filter((l) => l.origin === 'platform-curated-negative');
    const negativeSpecificity = negatives.length
        ? Math.max(...negatives.map((l) => l.specificity ?? 0))
        : -1;
    const survivors = matched.filter(
        (l) =>
            l.origin === 'user' ||
            (l.origin !== 'platform-curated-negative' &&
                (l.specificity ?? 0) > negativeSpecificity),
    );

    let label: SensitivityLabel = 'internal';
    let specificity = 0;
    for (const survivor of survivors) {
        if (LABEL_RANK[survivor.label] > LABEL_RANK[label]) label = survivor.label;
        specificity = Math.max(specificity, survivor.specificity ?? 0);
    }
    return {
        label,
        boundary: survivors.some((l) => l.boundary === true),
        specificity,
        matches: survivors,
    };
}

/** Immutable, content-versioned AssetLabel registry (TCB component). */
export class AssetLabelRegistry {
    readonly labels: readonly AssetLabel[];
    readonly version: number;
    readonly home?: string;
    readonly workspaceRoot?: string;

    constructor(labels: readonly AssetLabel[], opts: LabelRegistryOptions = {}) {
        this.labels = [...labels].map(normalizeLabel);
        this.home = opts.home;
        this.workspaceRoot = opts.workspaceRoot;
        this.version = contentVersion(this.labels);
    }

    static builtin(opts: LabelRegistryOptions = {}): AssetLabelRegistry {
        return new AssetLabelRegistry(BUILTIN_ASSET_LABELS, opts);
    }

    withUserLabels(labels: readonly Omit<AssetLabel, 'origin'>[]): AssetLabelRegistry {
        const user = labels.map((l) => ({ ...l, origin: 'user' as const }));
        return new AssetLabelRegistry([...this.labels, ...user], {
            home: this.home,
            workspaceRoot: this.workspaceRoot,
        });
    }

    resolve(query: AssetQuery): ResolvedLabel {
        return resolveLabel(query, this.labels, {
            home: this.home,
            workspaceRoot: this.workspaceRoot,
        });
    }
}
