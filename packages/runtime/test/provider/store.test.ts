import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProfileSnapshot } from '../../src/provider/profile.js';
import { FileProfileStore } from '../../src/provider/store.js';

let dir: string;
let file: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mazi-profile-'));
    file = join(dir, 'profiles.json');
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

const snapshot: ProfileSnapshot = {
    models: {
        'p/m': {
            performance: {
                tokensPerSecond: { p50: 1, p90: 2, p95: 3 },
                ttftMs: { p50: 10, p90: 20, p95: 30 },
                e2eLatencyMs: { p50: 100, p90: 200, p95: 300 },
                errorRate: 0,
                toolCallSchemaCompliance: 0,
                sampleSize: 5,
                windowMs: 3_600_000,
                lastUpdated: 1,
            },
            economics: {
                avgTaskCostUsd: 0.01,
                avgTokensPerTurn: { input: 10, output: 5 },
                qualitySampleSize: 0,
                retryRate: 0,
                sampleSize: 5,
                lastUpdated: 1,
            },
        },
    },
    savedAt: 1,
};

describe('FileProfileStore（§7.4）', () => {
    it('save/load 往返一致', async () => {
        const store = new FileProfileStore(file);
        await store.save(snapshot);
        const loaded = await store.load();
        expect(loaded).toEqual(snapshot);
    });

    it('文件不存在 → null', async () => {
        const store = new FileProfileStore(join(dir, 'missing.json'));
        expect(await store.load()).toBeNull();
    });

    it('损坏文件 → null（记日志）', async () => {
        const bad = join(dir, 'bad.json');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(bad, '{not json', 'utf8');
        const warns: string[] = [];
        const store = new FileProfileStore(bad, { logger: { warn: (m) => warns.push(m) } });
        expect(await store.load()).toBeNull();
        expect(warns.length).toBeGreaterThan(0);
    });
});
