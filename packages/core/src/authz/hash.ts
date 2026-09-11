/**
 * Deterministic content hashing for TCB versioning (T1).
 *
 * `contentVersion` gives registries a stable numeric version derived from their
 * content, so a derive snapshot can pin `labels@v / roles@v / rules@v` and
 * attribute a policy decision to an exact TCB revision.
 */

export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit, returned as an unsigned integer (0..2^32-1). */
export function fnv1a32(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

export function contentVersion(value: unknown): number {
    return fnv1a32(stableStringify(value));
}
