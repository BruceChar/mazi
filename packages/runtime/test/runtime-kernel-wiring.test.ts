import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeConfig(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
        wiki: { enabled: false },
    };
}

describe('HarnessRuntime × RuntimeKernel（§5 接线）', () => {
    it('核心服务登记为 kernel 服务，close 时逆序回收', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-kernel-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), { workspaceRoot: dir });
        try {
            expect(runtime.kernel.stateOf('eventBus')).toBe('active');
            expect(runtime.kernel.stateOf('hooks')).toBe('active');
            expect(runtime.kernel.get('hooks')).toBe(runtime.hooks);
            expect(runtime.kernel.get('eventBus')).toBe(runtime.eventBus);
        } finally {
            await runtime.close();
        }
        expect(runtime.kernel.stateOf('hooks')).toBe('disposed');
        expect(() => runtime.kernel.get('hooks')).toThrow(/disposed/);
    });
});
