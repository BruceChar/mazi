/**
 * Verb matcher (§7.1) — value-layer detection that re-roles an operation to
 * its real effect. `rm` becomes delete (committed → R1), `DROP` becomes ddl,
 * and so on. The matcher belongs to the TCB.
 */

import type { Commit } from './types.js';

export interface VerbMatch {
    verb: string;
    action: string;
    commit: Commit;
    reason: string;
}

interface VerbPattern {
    verb: string;
    pattern: RegExp;
    action: string;
    commit: Commit;
    reason: string;
}

const VERB_PATTERNS: readonly VerbPattern[] = [
    {
        verb: 'rm',
        pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*/i,
        action: 'delete',
        commit: 'committed',
        reason: 'rm 删除不可撤回 → R1',
    },
    {
        verb: 'shred',
        pattern: /\bshred\b/i,
        action: 'delete',
        commit: 'committed',
        reason: 'shred 覆写删除不可撤回 → R1',
    },
    {
        verb: 'dd',
        pattern: /\bdd\b[^\n]*\bof=\/dev\//i,
        action: 'write',
        commit: 'committed',
        reason: 'dd 写块设备不可撤回 → R1',
    },
    {
        verb: 'drop',
        pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
        action: 'ddl',
        commit: 'committed',
        reason: 'DDL 不可撤回 → R1',
    },
    {
        verb: 'delete-no-where',
        pattern: /\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)/i,
        action: 'delete',
        commit: 'committed',
        reason: 'DELETE 无 WHERE → R1',
    },
    {
        verb: 'git-push-force',
        pattern: /\bgit\s+push\b[^\n]*--force\b/i,
        action: 'publish',
        commit: 'committed',
        reason: 'git push --force 覆写远端历史 → R1',
    },
];

/** Match a command (and optional SQL) against the danger-verb corpus. */
export function matchVerb(command: string, sql?: string): VerbMatch[] {
    const text = sql ? `${command}\n${sql}` : command;
    return VERB_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => ({
        verb: p.verb,
        action: p.action,
        commit: p.commit,
        reason: p.reason,
    }));
}

/** Always choose the most conservative (committed) re-role when several match. */
export function strongestVerb(matches: readonly VerbMatch[]): VerbMatch | undefined {
    return matches.find((m) => m.commit === 'committed') ?? matches[0];
}

export function isDangerVerb(command: string, sql?: string): boolean {
    return matchVerb(command, sql).length > 0;
}
