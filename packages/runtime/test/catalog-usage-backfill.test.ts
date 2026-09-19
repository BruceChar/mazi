import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Goal, Step, Task } from '@mazi/core';
import { ulid } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfig, RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';
import {
    CatalogService,
    MemoryCatalogStore,
    observedCatalogFromProviderConfigs,
} from '../src/provider/catalog/index.js';

const dirs: string[] = [];
function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-usage-bf-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: join(dir, 'mazi.db'),
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

function providerConfig(): ProviderConfig {
    return {
        id: 'deepseek',
        vendor: 'deepseek',
        models: [{ id: 'deepseek-flash' }],
        driver: { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-flash' },
        pricing: {
            currency: 'USD',
            base: { inputPerMTok: 1, outputPerMTok: 4 },
            tiers: [],
            effectiveAt: 0,
            version: 'v1',
        },
    };
}

describe('花费账本历史回填', () => {
    it('把 Step.usage.raw 结算为凭证；id=bf:<stepId> 且幂等', async () => {
        const dir = tmpDir();
        const runtime = new HarnessRuntime(configIn(dir));
        const service = await CatalogService.open({ store: new MemoryCatalogStore() });
        const observed = observedCatalogFromProviderConfigs([providerConfig()]);
        await service.sync(observed.catalog, { source: 'manual-import' });

        const goalId = ulid();
        const goal: Goal = {
            goalId,
            origin: { kind: 'human' },
            statement: 's',
            contract: {
                successConditions: [],
                failureConditions: [],
                forbiddenResources: [],
                budget: {},
                terminationPolicy: {},
                riskProfile: {
                    hasIrreversibleActions: false,
                    touchesNetwork: false,
                    touchesExternalApi: false,
                },
            },
            permissionCeiling: 'read-only',
            budget: {},
            status: 'active',
            createdAt: 1,
        };
        const taskId = ulid();
        const task: Task = {
            taskId,
            goalId,
            title: 't',
            acceptance: { conditions: [] },
            status: 'succeeded',
        };
        const stepId = ulid();
        const step: Step = {
            stepId,
            taskId,
            goalId,
            kind: 'deliberation',
            payload: { answer: 'x' },
            status: 'succeeded',
            startedAt: 1234,
            usage: {
                raw: {
                    providerId: 'deepseek',
                    modelId: 'deepseek-flash',
                    inputTokens: 100,
                    outputTokens: 50,
                },
            } as unknown as Step['usage'],
        };
        await runtime.goalStore.saveGoal(goal);
        await runtime.goalStore.saveTask(task);
        await runtime.goalStore.saveStep(step);
        runtime.setCatalog(service);

        try {
            expect(await runtime.backfillUsage()).toEqual({ recorded: 1, skipped: 0 });
            const records = await service.usageRecords();
            expect(records).toHaveLength(1);
            expect(records[0]?.id).toBe('bf:' + stepId);
            expect(records[0]?.modelId).toBe('deepseek-flash');
            expect(records[0]?.occurredAt).toBe(1234);
            // 幂等：再次回填不重复写。
            expect(await runtime.backfillUsage()).toEqual({ recorded: 0, skipped: 1 });
            expect(await service.usageRecords()).toHaveLength(1);
        } finally {
            await runtime.close();
        }
    });
});
