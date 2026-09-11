/**
 * Glob dialect for the AssetLabel registry.
 *
 * Supported: `**` (any characters including '/'), `*` (within one path
 * segment), `?` (one non-'/' character), `~` (home). This dialect is pinned
 * by unit tests (AuthzLabelGlobTest) — label resolution depends on its exact
 * semantics.
 */

const REGEXP_SPECIAL = new Set(['\\', '^', '$', '{', '}', '(', ')', '[', ']', '|', '+', '.']);

/** Expand a leading `~` using the supplied home directory. */
export function expandHome(value: string, home: string): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return home.replace(/\/+$/, '') + value.slice(1);
    return value;
}

/** Normalize separators and expand `~` for both patterns and asset values. */
export function normalizeAssetPath(value: string, home?: string): string {
    const slashed = value.replace(/\\/g, '/');
    return home ? expandHome(slashed, home) : slashed;
}

export function globToRegExp(glob: string): RegExp {
    let source = '';
    let i = 0;
    while (i < glob.length) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                i += 2;
                if (glob[i] === '/') {
                    source += '(?:.*/)?';
                    i += 1;
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
                i += 1;
            }
        } else if (ch === '?') {
            source += '[^/]';
            i += 1;
        } else if (REGEXP_SPECIAL.has(ch)) {
            source += `\\${ch}`;
            i += 1;
        } else {
            source += ch;
            i += 1;
        }
    }
    return new RegExp(`^${source}$`);
}

const regexpCache = new Map<string, RegExp>();

export function matchGlob(pattern: string, value: string): boolean {
    let compiled = regexpCache.get(pattern);
    if (!compiled) {
        compiled = globToRegExp(pattern);
        regexpCache.set(pattern, compiled);
    }
    return compiled.test(value);
}

/** Concreteness: number of characters that are not `*` or `?`. */
export function specificityOf(pattern: string): number {
    let count = 0;
    for (const ch of pattern) {
        if (ch !== '*' && ch !== '?') count += 1;
    }
    return count;
}

/** True when `child` is lexically inside `root` (after normalization). */
export function isInsidePath(child: string, root: string): boolean {
    const normalizedRoot = root.replace(/\/+$/, '');
    if (normalizedRoot === '') return false;
    return child === normalizedRoot || child.startsWith(`${normalizedRoot}/`);
}
