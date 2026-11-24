import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import type { DefaultEventBus } from '../src/events/event-bus.js';
import { HarnessRuntime } from '../src/harness/index.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function throwingProvider(): LLMProvider {
    const fail = async () => {
        throw new ProviderError('network', 'provider exploded');
    };
    return {
        id: 'faux',
        name: 'faux',
        defaultModel: 'faux-model',
        models: [],
        ask: fail,
        async *askStream() {
            await fail();
        },
    };
}

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

describe('异常收尾', () => {
    it('provider 异常时 Task/Goal 落 failed，不能停在 active', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-closure-'));
        dirs.push(dir);
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: throwingProvider() },
        });
        try {
            const created = await runtime.createGoalSession('触发一次异常');
            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(result.ok).toBe(false);
            expect(result.tasks[0]?.reason).toBe('driver-error');
            expect(result.tasks[0]?.task.status).toBe('failed');
            const snapshot = await runtime.goalSnapshot(created.rootGoalId);
            expect(snapshot.goals.length).toBeGreaterThan(0);
            expect(snapshot.goals.every((goal) => goal.status === 'failed')).toBe(true);
            const storedGoals = await runtime.goalStore.listGoalsByRoot(created.rootGoalId);
            expect(storedGoals.every((goal) => goal.endedAt !== undefined)).toBe(true);
            const events = (runtime.eventBus as DefaultEventBus).replay(created.rootGoalId);
            expect(
                events.some(
                    (event) =>
                        event.type === 'goal.ended' &&
                        (event.payload as { outcome?: { status?: string } }).outcome?.status ===
                            'failed',
                ),
            ).toBe(true);
        } finally {
            await runtime.close();
        }
    });
});
