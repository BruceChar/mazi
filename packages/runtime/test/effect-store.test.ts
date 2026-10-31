import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    effectPathsForTool,
    MemoryEffectStore,
    newEffectRecord,
    rollbackEffects,
    snapshotFiles,
    SqliteEffectStore,
} from '../src/effects/effect-store.js';

function workspace(): string {
    return mkdtempSync(join(tmpdir(), 'mazi-effects-'));
}

describe('effect journal', () => {
    it('snapshots and restores only explicitly scoped file effects', async () => {
        const root = workspace();
        const file = join(root, 'a.txt');
        writeFileSync(file, 'before');
        const paths = effectPathsForTool(
            { name: 'sd', sideEffects: ['fs'] },
            { path: 'a.txt', pattern: 'x', replacement: 'y' },
        );
        expect(paths).toEqual(['a.txt']);
        const before = snapshotFiles(root, paths);
        writeFileSync(file, 'after');
        const store = new MemoryEffectStore();
        await store.append(
            newEffectRecord({
                rootGoalId: 'r1',
                goalId: 'g1',
                taskId: 't1',
                stepId: 's1',
                toolName: 'sd',
                args: { path: 'a.txt' },
                before,
            }),
        );

        const changed = await rollbackEffects(store, 'r1', root, () => 42);
        expect(changed[0]).toMatchObject({ status: 'rolled-back', rolledBackAt: 42 });
        expect(readFileSync(file, 'utf8')).toBe('before');
    });

    it('removes a file that did not exist before the tool ran', async () => {
        const root = workspace();
        const file = join(root, 'new.txt');
        const before = snapshotFiles(root, ['new.txt']);
        writeFileSync(file, 'created');
        const store = new MemoryEffectStore();
        await store.append(
            newEffectRecord({
                rootGoalId: 'r1',
                goalId: 'g1',
                taskId: 't1',
                stepId: 's1',
                toolName: 'write',
                args: { path: 'new.txt' },
                before,
            }),
        );
        await rollbackEffects(store, 'r1', root);
        expect(existsSync(file)).toBe(false);
    });

    it('does not pretend arbitrary shell/git effects are reversible', () => {
        expect(
            effectPathsForTool(
                { name: 'shell.run', sideEffects: ['fs', 'net'] },
                { path: 'a.txt' },
            ),
        ).toEqual([]);
        expect(
            effectPathsForTool(
                { name: 'git', sideEffects: ['fs'] },
                { args: ['reset', '--hard'] },
            ),
        ).toEqual([]);
    });

    it('persists journal records across SQLite store instances', async () => {
        const root = workspace();
        const dbPath = join(root, 'effects.db');
        const file = join(root, 'a.txt');
        writeFileSync(file, 'x');
        const store = new SqliteEffectStore(dbPath);
        await store.append(
            newEffectRecord({
                rootGoalId: 'r1',
                goalId: 'g1',
                taskId: 't1',
                stepId: 's1',
                toolName: 'sd',
                args: { path: 'a.txt' },
                before: snapshotFiles(root, ['a.txt']),
            }),
        );
        store.close();
        const reopened = new SqliteEffectStore(dbPath);
        expect(await reopened.list('r1')).toHaveLength(1);
        reopened.close();
    });
});
