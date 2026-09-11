/**
 * AssetLabel registry — unified sensitivity annotations with N15 conflict
 * resolution, platform-curated negative entries (B1) and suppression
 * aggregation (B3).
 *
 * Fail-safe defaults (P13/N1): an unannotated asset is `internal`; a doubtful
 * asset is `sensitive`. The conservative direction is not configurable.
 */

import { isInsidePath, matchGlob, normalizeAssetPath, specificityOf } from './glob.js';
import { contentVersion } from './hash.js';
import {
    type AssetKind,
    type AssetLabel,
    type AssetQuery,
    LABEL_RANK,
    type LabelResolutionEvent,
    type ResolvedLabel,
    type SensitivityLabel,
} from './types.js';

const HOME_USER_DATA_PATTERN = '~/**';

/**
 * Built-in platform annotations (§4.2 table + §7.3 boundary set). Users may
 * append entries; secret-level platform declarations cannot be downgraded by
 * user declarations (N15).
 */
export const BUILTIN_ASSET_LABELS: readonly AssetLabel[] = [
    // —— secrets: mandatory severance on read; write forbidden (V17) ——
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

    // —— platform-curated negative entries (B1): the low-cost secret outlet ——
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

    // —— boundary set §7.3: identity persistence ——
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

    // —— boundary set §7.3: execution persistence ——
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

    // —— boundary set §7.3: shell rc / profiles ——
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

    // —— boundary set §7.3: supply-chain hooks ——
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

    // —— boundary set §7.3: tool-config persistence ——
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

    // —— boundary set §7.3: harness self-envelope (TCB self-reference, T2) ——
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

export function normalizeAssetLabel(label: AssetLabel): AssetLabel {
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
 * N15 conflict resolution.
 *
 *  - secret-level platform annotations cannot be downgraded by user
 *    declarations; each attempt emits a suppression event (B3 aggregation);
 *  - platform-curated negative entries are a legal secret-downgrade outlet:
 *    a negative matching at least as specifically as a secret pattern cancels
 *    that secret declaration (the asset falls through to internal);
 *  - sensitive and below: strictest label wins → more specific pattern →
 *    user origin over platform;
 *  - boundary is the union of all surviving matches.
 */
export function resolveLabel(
    query: AssetQuery,
    labels: readonly AssetLabel[],
    opts: LabelRegistryOptions = {},
): ResolvedLabel {
    const value = query.kind === 'path' ? normalizeAssetPath(query.value, opts.home) : query.value;
    const matched = labels
        .filter((label) => label.kind === query.kind && matches(label, value, opts))
        .map(normalizeAssetLabel);

    const negatives = matched.filter((l) => l.origin === 'platform-curated-negative');
    const positives = matched.filter((l) => l.origin !== 'platform-curated-negative');
    const negativeSpecificity = negatives.length
        ? Math.max(...negatives.map((l) => l.specificity ?? 0))
        : -1;
    // A platform-curated negative entry cancels every broader platform
    // positive declaration (secret and non-secret): it is the platform's
    // known-safe statement for that asset. User declarations are never
    // cancelled — a user may still explicitly raise an asset.
    const survivors = positives.filter(
        (l) => l.origin === 'user' || (l.specificity ?? 0) > negativeSpecificity,
    );

    const suppressed: LabelResolutionEvent[] = [];
    const platformSecret = survivors.filter((l) => l.label === 'secret' && l.origin !== 'user');
    let label: SensitivityLabel;
    if (platformSecret.length > 0) {
        label = 'secret';
        for (const user of survivors) {
            if (user.origin === 'user' && LABEL_RANK[user.label] < LABEL_RANK.secret) {
                suppressed.push({
                    reason: 'user-downgrade-suppressed',
                    kind: query.kind,
                    asset: value,
                    userLabel: user.label,
                    enforcedLabel: 'secret',
                });
            }
        }
    } else {
        const ranked = [...survivors].sort(compareLabels);
        label = ranked[0]?.label ?? 'internal';
    }

    const ranked = [...survivors].sort(compareLabels);
    return {
        label,
        boundary: survivors.some((l) => l.boundary === true),
        specificity: ranked[0]?.specificity ?? 0,
        matches: ranked,
        suppressed,
        fromOverlay: false,
    };
}

/** Strictest label → higher specificity → user origin over platform. */
function compareLabels(a: AssetLabel, b: AssetLabel): number {
    const byLabel = LABEL_RANK[b.label] - LABEL_RANK[a.label];
    if (byLabel !== 0) return byLabel;
    const bySpecificity = (b.specificity ?? 0) - (a.specificity ?? 0);
    if (bySpecificity !== 0) return bySpecificity;
    return originRank(b.origin) - originRank(a.origin);
}

function originRank(origin: AssetLabel['origin']): number {
    if (origin === 'user') return 2;
    if (origin === 'platform') return 1;
    return 0;
}

/** Immutable, versioned AssetLabel registry (TCB component). */
export class AssetLabelRegistry {
    readonly labels: readonly AssetLabel[];
    readonly version: number;
    readonly home?: string;
    readonly workspaceRoot?: string;

    constructor(labels: readonly AssetLabel[], opts: LabelRegistryOptions = {}) {
        this.labels = [...labels].map(normalizeAssetLabel);
        this.home = opts.home;
        this.workspaceRoot = opts.workspaceRoot;
        this.version = contentVersion(this.labels);
    }

    static builtin(opts: LabelRegistryOptions = {}): AssetLabelRegistry {
        return new AssetLabelRegistry(BUILTIN_ASSET_LABELS, opts);
    }

    withUserLabels(labels: readonly AssetLabel[]): AssetLabelRegistry {
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

export interface SuppressionGroup {
    asset: string;
    kind: AssetKind;
    userLabel: SensitivityLabel;
    enforcedLabel: SensitivityLabel;
    count: number;
}

/** Aggregate suppression events for UI presentation (B3). */
export function aggregateSuppressions(events: readonly LabelResolutionEvent[]): SuppressionGroup[] {
    const groups = new Map<string, SuppressionGroup>();
    for (const event of events) {
        const key = `${event.kind}:${event.asset}:${event.userLabel}`;
        const existing = groups.get(key);
        if (existing) {
            existing.count += 1;
        } else {
            groups.set(key, {
                asset: event.asset,
                kind: event.kind,
                userLabel: event.userLabel,
                enforcedLabel: event.enforcedLabel,
                count: 1,
            });
        }
    }
    return [...groups.values()];
}

/** Chinese user-facing notice for aggregated suppressions (B3). */
export function formatSuppressionNotice(groups: readonly SuppressionGroup[]): string {
    if (groups.length === 0) return '全部标注均已生效。';
    const listed = groups.map((g) => `${g.asset}（声明 ${g.userLabel} → 强制 ${g.enforcedLabel}）`);
    return `你的 ${groups.length} 条标注未生效：${listed.join('、')}`;
}
