import 'reflect-metadata';
import { MemoryManager, PersonalMemoryService } from '@mazi/runtime';
import { describe, expect, it } from 'vitest';
import type { ApiRuntimeService } from '../src/common/runtime.service.js';
import { MemoryController } from '../src/memory/memory.controller.js';

function makeController(): {
    controller: MemoryController;
    service: PersonalMemoryService;
} {
    const service = new PersonalMemoryService(new MemoryManager());
    const runtime = {
        harness: () => ({ personalMemoryService: () => service }),
    } as unknown as ApiRuntimeService;
    return { controller: new MemoryController(runtime), service };
}

describe('memory controller', () => {
    it('creates, lists, confirms, corrects and tombstones user memory', async () => {
        const { controller, service } = makeController();
        const created = await controller.remember({
            userId: 'u1',
            kind: 'preference',
            text: '回答保持简洁',
            projectId: 'p1',
            tags: ['style'],
        });
        const memoryId = created.item.id;
        expect(created.item).toMatchObject({
            userId: 'u1',
            projectId: 'p1',
            provenance: { confidence: 'confirmed' },
        });

        const listed = await controller.list('u1', 'p1', '简洁', '20');
        expect(listed.items).toHaveLength(1);

        const candidate = await service.rememberCandidate({
            userId: 'u1',
            kind: 'fact',
            text: '使用 MySQL',
        });
        const confirmed = await controller.update(candidate.id, { action: 'confirm' });
        expect(confirmed.item.provenance?.confidence).toBe('confirmed');

        const corrected = await controller.update(memoryId, {
            action: 'correct',
            text: '回答保持非常简洁',
        });
        expect(corrected.item.supersedes).toEqual([memoryId]);

        const forgotten = await controller.forget(corrected.item.id);
        expect(forgotten.ok).toBe(true);
        expect(
            (await service.list({ userId: 'u1', status: 'all' })).find(
                (item) => item.id === corrected.item.id,
            )?.status,
        ).toBe('tombstoned');
    });

    it('rejects incomplete memory writes', async () => {
        const { controller } = makeController();
        await expect(controller.remember({ kind: 'fact', text: 'x' })).rejects.toThrow(
            /userId/,
        );
    });
});
