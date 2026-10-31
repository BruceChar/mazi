import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ContextManager } from '../src/harness/context-manager.js';
import {
    InMemoryMemoryStore,
    exportMemoryBundle,
    importMemoryBundle,
    MemoryManager,
    type MemoryItem,
    recentMemoryPolicy,
    SqliteMemoryStore,
    turnsToMemory,
} from '../src/memory/index.js';
import { estimateTokens } from '../src/token-estimator.js';

function turn(id: string, text: string, createdAt: number, role: 'user' | 'assistant' = 'user'): MemoryItem {
    return { id, kind: 'turn', role, text, createdAt };
}

function note(id: string, text: string, createdAt: number): MemoryItem {
    return { id, kind: 'fact', text, createdAt };
}

describe('InMemoryMemoryStore', () => {
    it('appends, filters by root/conversation and orders by createdAt', async () => {
        const store = new InMemoryMemoryStore();
        await store.append([
            { ...turn('a', 'one', 2), rootGoalId: 'r1' },
            { ...turn('b', 'two', 1), rootGoalId: 'r2' },
            { ...turn('c', 'three', 3), conversationId: 'c1' },
        ]);
        const byRoot = await store.recall({ rootGoalId: 'r1' });
        expect(byRoot.map((item) => item.id)).toEqual(['a']);
        const byConversation = await store.recall({ conversationId: 'c1' });
        expect(byConversation.map((item) => item.id)).toEqual(['c']);
        const all = await store.recall({});
        expect(all.map((item) => item.createdAt)).toEqual([1, 2, 3]);
    });

    it('returns clones and clears by query', async () => {
        const store = new InMemoryMemoryStore();
        await store.append([{ ...turn('a', 'one', 1), rootGoalId: 'r1' }]);
        const first = await store.recall({ rootGoalId: 'r1' });
        (first[0] as MemoryItem).text = 'mutated';
        expect((await store.recall({ rootGoalId: 'r1' }))[0]?.text).toBe('one');

        await store.clear({ rootGoalId: 'r1' });
        expect(await store.recall({ rootGoalId: 'r1' })).toHaveLength(0);
    });
});

describe('recentMemoryPolicy', () => {
    it('dedupes by id keeping the latest and preserves time order', () => {
        const policy = recentMemoryPolicy();
        const selected = policy.select(
            [turn('a', 'old', 1), turn('b', 'b', 2), turn('a', 'new', 3)],
            {},
        );
        expect(selected.map((item) => item.id)).toEqual(['b', 'a']);
        expect(selected[1]?.text).toBe('new');
    });

    it('honors the limit from the most recent end', () => {
        const policy = recentMemoryPolicy();
        const selected = policy.select([turn('a', 'a', 1), turn('b', 'b', 2), turn('c', 'c', 3)], {
            limit: 2,
        });
        expect(selected.map((item) => item.id)).toEqual(['b', 'c']);
    });

    it('fills the token budget from the newest memory', () => {
        const policy = recentMemoryPolicy();
        const newest = turn('c', 'x'.repeat(100), 3);
        const budget = estimateTokens(newest.text);
        const selected = policy.select([turn('a', 'a', 1), turn('b', 'b', 2), newest], {
            budgetTokens: budget,
        });
        expect(selected.map((item) => item.id)).toEqual(['c']);
    });
});

describe('turnsToMemory', () => {
    it('maps turns in order with increasing timestamps and unique ids', () => {
        const items = turnsToMemory(
            [
                { role: 'user', text: 'q' },
                { role: 'assistant', text: 'a' },
            ],
            { rootGoalId: 'r1', now: () => 1000, id: (index) => `id-${index}` },
        );
        expect(items.map((item) => item.id)).toEqual(['id-0', 'id-1']);
        expect(items.map((item) => item.createdAt)).toEqual([1000, 1001]);
        expect(items.map((item) => item.rootGoalId)).toEqual(['r1', 'r1']);
        expect(items[1]?.role).toBe('assistant');
    });
});

describe('MemoryManager', () => {
    it('remembers and recalls scoped memory through the policy', async () => {
        const memory = new MemoryManager();
        await memory.remember([]);
        await memory.remember([{ ...turn('a', 'one', 1), rootGoalId: 'r1' }]);
        await memory.remember([{ ...turn('b', 'two', 2), rootGoalId: 'r2' }]);
        expect((await memory.recall({ rootGoalId: 'r1' })).map((item) => item.id)).toEqual(['a']);
        await memory.forget({ rootGoalId: 'r1' });
        expect(await memory.recall({ rootGoalId: 'r1' })).toHaveLength(0);
    });

    it('separates messages from system notes in a contribution', () => {
        const memory = new MemoryManager();
        const contribution = memory.toContribution(
            [turn('u', 'question', 1), turn('a', 'answer', 2, 'assistant'), note('f', 'fact', 3)],
            { id: 'memory:test' },
        );
        expect(contribution.id).toBe('memory:test');
        expect(contribution.systemPrompt?.()).toBe('fact');
        const messages = contribution.messages?.() ?? [];
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });

    it('feeds the ContextManager as a pre-existing contribution', async () => {
        const memory = new MemoryManager();
        await memory.remember(turnsToMemory([{ role: 'user', text: 'history' }]));
        const contribution = await memory.prepareContribution();
        const context = new ContextManager({ contributions: [contribution] });
        context.appendUser('current');
        expect(context.baseMessageCount()).toBe(1);
        expect(context.messages().map((message) => message.role)).toEqual(['user', 'user']);
    });

    it('unions user/workspace/conversation scopes while excluding expired or tombstoned memory', async () => {
        const store = new InMemoryMemoryStore();
        await store.append([
            {
                ...note('user', 'preference', 1),
                userId: 'u1',
                provenance: { source: 'user', confidence: 'confirmed', trustTier: 'T1' },
            },
            { ...note('workspace', 'project fact', 2), workspaceId: '/w1' },
            { ...note('conversation', 'previous task', 3), conversationId: 'c1' },
            { ...note('expired', 'old', 4), userId: 'u1', expiresAt: 10 },
            { ...note('deleted', 'gone', 5), userId: 'u1', status: 'tombstoned' },
        ]);
        const memory = new MemoryManager({ store });
        const recalled = await memory.recall({
            userId: 'u1',
            workspaceId: '/w1',
            conversationId: 'c1',
            unionScope: true,
        });
        expect(recalled.map((item) => item.id).sort()).toEqual([
            'conversation',
            'user',
            'workspace',
        ]);
    });

    it('persists cross-session scoped memory in SQLite', async () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), 'mazi-memory-')), 'memory.db');
        const first = new SqliteMemoryStore(dbPath);
        await first.append([
            {
                ...note('pref', '回答保持简洁', 1),
                userId: 'u1',
                workspaceId: '/w1',
                provenance: { source: 'user', confidence: 'confirmed', trustTier: 'T1' },
            },
        ]);
        first.close();

        const second = new SqliteMemoryStore(dbPath);
        const recalled = await second.recall({ userId: 'u1', workspaceId: '/w1' });
        expect(recalled[0]).toMatchObject({
            id: 'pref',
            userId: 'u1',
            workspaceId: '/w1',
        });
        second.close();
    });

    it('exports and imports a versioned checksummed memory bundle', async () => {
        const source = new MemoryManager();
        await source.remember([
            {
                ...note('pref', '中文回答', 1),
                userId: 'u1',
                provenance: { source: 'user', confidence: 'confirmed', trustTier: 'T1' },
            },
            {
                ...note('task', '已完成迁移', 2),
                workspaceId: '/w1',
                provenance: { source: 'system', confidence: 'confirmed', trustTier: 'T2' },
            },
        ]);
        const bundle = await exportMemoryBundle(source, () => 42, [
            {
                rootGoalId: 'r1',
                head: 'h1',
                events: [
                    {
                        eventId: 'e1',
                        type: 'approval.granted',
                        rootGoalId: 'r1',
                        timestamp: 1,
                        attributes: {},
                        actor: 'human',
                    },
                ],
            },
        ]);
        expect(bundle).toMatchObject({
            format: 'mazi-memory-bundle',
            schemaVersion: 1,
            exportedAt: 42,
        });
        expect(bundle.checksum).toMatch(/^[0-9a-f]{64}$/);
        expect(bundle.auditTrails?.[0]?.events[0]?.type).toBe('approval.granted');

        const target = new MemoryManager();
        expect(await importMemoryBundle(target, bundle)).toEqual({ imported: 2 });
        expect((await target.recall({ userId: 'u1' }))[0]?.text).toBe('中文回答');

        const tampered = { ...bundle, records: [{ ...bundle.records[0]!, text: 'changed' }] };
        await expect(importMemoryBundle(target, tampered)).rejects.toThrow(/checksum/);
        const auditTampered = {
            ...bundle,
            auditTrails: [{ ...bundle.auditTrails![0]!, head: 'changed' }],
        };
        await expect(importMemoryBundle(target, auditTampered)).rejects.toThrow(/checksum/);
    });
});
