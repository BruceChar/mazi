import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    loadRuntimeConfig,
    loadRuntimeSettings,
    resolveScopedPermission,
    saveRuntimeSettings,
} from '../src/config-io.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-settings-'));
    dirs.push(dir);
    return dir;
}

describe('system settings (settings.json)', () => {
    it('persists and reloads the system permission grant', () => {
        const dir = tmp();
        expect(loadRuntimeConfig(dir).goal).toBeUndefined();
        saveRuntimeSettings({ goal: { permissionCeiling: 'workspace-write' } }, dir);
        expect(loadRuntimeConfig(dir).goal?.permissionCeiling).toBe('workspace-write');
    });

    it('merges fields without dropping existing settings', () => {
        const dir = tmp();
        saveRuntimeSettings({ goal: { permissionCeiling: 'read-only', allowedTools: ['fs.read'] } }, dir);
        saveRuntimeSettings({ goal: { permissionCeiling: 'autonomous' } }, dir);
        const config = loadRuntimeConfig(dir);
        expect(config.goal?.permissionCeiling).toBe('autonomous');
        expect(config.goal?.allowedTools).toEqual(['fs.read']);
    });

    it('keeps workspace and conversation overrides independent', () => {
        const dir = tmp();
        saveRuntimeSettings({ permissions: { 'workspace:/p/a': 'read-only' } }, dir);
        saveRuntimeSettings({ permissions: { 'conversation:c1': 'autonomous' } }, dir);
        // Adding a conversation override must not drop the workspace one.
        saveRuntimeSettings({ goal: { permissionCeiling: 'workspace-write' } }, dir);
        expect(loadRuntimeSettings(dir).permissions).toEqual({
            'workspace:/p/a': 'read-only',
            'conversation:c1': 'autonomous',
        });
    });
});

describe('resolveScopedPermission', () => {
    const permissions = {
        'workspace:/p/a': 'read-only',
        'workspace:/p/b': 'workspace-write',
        'conversation:c1': 'autonomous',
    };

    it('prefers the conversation override over the workspace override', () => {
        expect(
            resolveScopedPermission(permissions, {
                workspace: '/p/a',
                conversationId: 'c1',
                fallback: 'read-only',
            }),
        ).toBe('autonomous');
    });

    it('falls back from workspace to the system default independently', () => {
        expect(
            resolveScopedPermission(permissions, { workspace: '/p/b', fallback: 'read-only' }),
        ).toBe('workspace-write');
        expect(
            resolveScopedPermission(permissions, { workspace: '/p/c', fallback: 'read-only' }),
        ).toBe('read-only');
    });

    it('uses the free-chat key when there is no workspace', () => {
        expect(
            resolveScopedPermission(
                { 'workspace:__free__': 'workspace-write' },
                { fallback: 'read-only' },
            ),
        ).toBe('workspace-write');
    });
});
