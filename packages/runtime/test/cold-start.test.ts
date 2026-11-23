import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configWithDb(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: join(dir, 'mazi.db'),
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
        wiki: { enabled: false },
    };
}

describe('冷构造', () => {
    it('装配阶段不打开 SQLite；首次访问才建库；close 幂等', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-cold-'));
        dirs.push(dir);
        const dbPath = join(dir, 'mazi.db');

        const cold = new HarnessRuntime(configWithDb(dir), { workspaceRoot: dir });
        expect(existsSync(dbPath)).toBe(false);
        await cold.close();
        expect(existsSync(dbPath)).toBe(false);

        const warm = new HarnessRuntime(configWithDb(dir), { workspaceRoot: dir });
        expect(await warm.goalStore.listAllSteps()).toEqual([]);
        expect(existsSync(dbPath)).toBe(true);
        await warm.close();
        await warm.close();
    });
});
