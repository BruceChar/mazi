import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadRuntimeConfig, saveRuntimeSettings } from '../src/config-io.js';

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
});
