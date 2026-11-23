import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultEventBus } from '../src/events/event-bus.js';
import {
    MemoryEffectStore,
    newEffectRecord,
    snapshotFiles,
} from '../src/effects/effect-store.js';
import { rollbackGoalEffects } from '../src/harness/rollback.js';

describe('rollbackGoalEffects', () => {
    it('无工作区根路径时拒绝回滚', async () => {
        await expect(
            rollbackGoalEffects(new MemoryEffectStore(), new DefaultEventBus(), undefined, 'r1'),
        ).rejects.toThrow(/工作区根路径/);
    });

    it('逐条回滚并把结果连同 rollback.executed 一起返回', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'mazi-rollback-'));
        const file = join(workspace, 'a.txt');
        writeFileSync(file, 'after');
        const store = new MemoryEffectStore();
        await store.append(
            newEffectRecord({
                rootGoalId: 'r1',
                goalId: 'g1',
                taskId: 't1',
                stepId: 's1',
                toolName: 'fs.write',
                args: { path: 'a.txt' },
                before: snapshotFiles(workspace, ['a.txt']),
            }),
        );
        writeFileSync(file, 'before');

        const bus = new DefaultEventBus();
        const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
        bus.subscribe(
            {},
            {
                id: 'capture',
                handle: (event) => {
                    events.push(event as unknown as { type: string });
                },
            },
        );
        const effects = await rollbackGoalEffects(store, bus, workspace, 'r1');
        expect(effects).toHaveLength(1);
        expect(effects[0]?.status).toBe('rolled-back');
        expect(events.map((event) => event.type)).toContain('rollback.executed');
    });
});
