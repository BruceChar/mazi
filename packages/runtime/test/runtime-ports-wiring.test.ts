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

describe('HarnessRuntime × RuntimePorts', () => {
    it('运行期 setter 写入 ports，不再重复持有同名字段', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-ports-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(runtimeConfig(dir), { workspaceRoot: dir });
        try {
            runtime.setSkillProvider({ mounted: () => [] } as never);
            expect(runtime.ports.get('skillProvider')).toBeDefined();
            runtime.setSkillProvider(undefined);
            expect(runtime.ports.get('skillProvider')).toBeUndefined();

            runtime.setTaskPlanner((() => undefined) as never);
            expect(runtime.ports.get('taskPlanner')).toBeDefined();

            runtime.setReplanPlanner((() => undefined) as never, 3);
            expect(runtime.ports.get('replanPlanner')).toBeDefined();
        } finally {
            await runtime.close();
        }
    });
});
