/**
 * Root-level grant presets and the full-access factory (§5.1).
 *
 * PRESETS cover the common task shapes; `fullAccessGrant` is root-only (P1)
 * and never appears on a derivation path. Neither exempts the R lower bounds
 * or the hard layer (V8/P10).
 */

import type { AgentGrant, CapabilityRule } from './types.js';

function cap(
    action: string,
    domain: CapabilityRule['domain'],
    extra: Partial<CapabilityRule> = {},
): CapabilityRule {
    return { action, domain, tier: 'auto', ...extra };
}

export const PRESETS: Readonly<Record<string, AgentGrant>> = {
    'read-only': {
        'fs.read.workspace': cap('fs.read', 'workspace', { maxLabel: 'internal' }),
    },
    workspace: {
        'fs.read.workspace': cap('fs.read', 'workspace'),
        'fs.write.sandbox': cap('fs.write', 'sandbox'),
        'fs.write.draft': cap('fs.write.draft', 'workspace', { scope: 'task-scratch' }),
    },
    'workspace-write': {
        'fs.read.workspace': cap('fs.read', 'workspace'),
        'fs.write.workspace': cap('fs.write', 'workspace'),
    },
} satisfies Record<string, AgentGrant>;

/**
 * Root-layer full-access grant. Declares the broadest will; the derivation
 * still applies every rule floor and the hard layer (V8).
 */
export function fullAccessGrant(): AgentGrant {
    const read = { severance: 'handle' as const };
    return {
        'fs.read.workspace': cap('fs.read', 'workspace', { maxLabel: 'secret', ...read }),
        'fs.read.sandbox': cap('fs.read', 'sandbox', { maxLabel: 'secret', ...read }),
        'fs.read.host': cap('fs.read', 'host', { maxLabel: 'secret', ...read }),
        'fs.write.sandbox': cap('fs.write', 'sandbox', { maxLabel: 'sensitive' }),
        'fs.write.draft': cap('fs.write.draft', 'workspace', { scope: 'task-scratch' }),
        'fs.write.workspace': cap('fs.write', 'workspace', { maxLabel: 'sensitive' }),
        'fs.write.host': cap('fs.write', 'host', { maxLabel: 'sensitive' }),
        'fs.exec': cap('fs.exec', 'sandbox'),
        'net.fetch': cap('net.fetch', 'external'),
        'net.send': cap('net.send', 'external'),
        'db.read': cap('db.read', 'host', { maxLabel: 'sensitive', ...read }),
        'db.write': cap('db.write', 'host', { maxLabel: 'sensitive' }),
        'db.schema': cap('db.schema', 'host', { maxLabel: 'sensitive' }),
        publish: cap('publish', 'external'),
        pay: cap('pay', 'external'),
        delete: cap('delete', 'workspace'),
    };
}
