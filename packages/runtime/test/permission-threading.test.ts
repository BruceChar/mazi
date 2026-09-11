import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/runtime.js';

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('per-run permission ceiling', () => {
    it('persists the requested ceiling on the goal tree (create → execute)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-perm-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(configIn(dir));
        const created = await runtime.createGoalSession('hi', { permissionCeiling: 'draft' });
        const goals = await runtime.goalStore.listGoalsByRoot(created.rootGoalId);
        const work = goals.find((goal) => goal.kind === 'work');
        expect(work?.permissionCeiling).toBe('draft');
        await runtime.close();
    });

    it('falls back to the configured default when the run does not specify one', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-perm-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(configIn(dir));
        const created = await runtime.createGoalSession('hi');
        const goals = await runtime.goalStore.listGoalsByRoot(created.rootGoalId);
        const work = goals.find((goal) => goal.kind === 'work');
        expect(work?.permissionCeiling).toBe('read-only');
        await runtime.close();
    });
});
