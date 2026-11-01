import { createHash } from 'node:crypto';
import { authz, ulid } from '@mazi/core';
import type { MemoryManager } from './memory.js';
import type { MemoryItem, MemoryLinks, MemoryProvenance, MemoryQuery } from './store.js';

export interface MemoryWriteInput {
    id?: string;
    kind: string;
    text: string;
    userId: string;
    projectId?: string;
    workspaceId?: string;
    conversationId?: string;
    rootGoalId?: string;
    tags?: readonly string[];
    importance?: number;
    links?: MemoryLinks;
    provenance?: MemoryProvenance;
    expiresAt?: number;
}

function contentHash(item: Pick<MemoryItem, 'kind' | 'text' | 'userId' | 'projectId'>): string {
    return createHash('sha256')
        .update(
            authz.stableStringify({
                kind: item.kind,
                text: item.text.trim(),
                userId: item.userId,
                projectId: item.projectId,
            }),
        )
        .digest('hex');
}

function importanceOf(kind: string): number {
    if (kind === 'preference') return 0.95;
    if (kind === 'decision') return 0.85;
    if (kind === 'fact' || kind === 'episode') return 0.7;
    return 0.5;
}

/**
 * User-memory write policy. Explicit statements are confirmed immediately;
 * model/tool-derived memories remain candidates until confirmed.
 */
export class PersonalMemoryService {
    constructor(
        private readonly memory: MemoryManager,
        private readonly now: () => number = Date.now,
    ) {}

    async rememberExplicit(input: MemoryWriteInput): Promise<MemoryItem> {
        return this.append(input, {
            source: 'user_explicit',
            confidence: 'confirmed',
            trustTier: 'T1',
        });
    }

    async rememberCandidate(input: MemoryWriteInput): Promise<MemoryItem> {
        return this.append(input, {
            source: input.provenance?.source ?? 'model_inferred',
            confidence: 'pending_confirmation',
            trustTier: input.provenance?.trustTier ?? 'T2',
        });
    }

    async confirm(memoryId: string): Promise<MemoryItem | undefined> {
        const item = await this.get(memoryId);
        if (item === undefined) return undefined;
        return this.update(item, {
            status: 'active',
            provenance: {
                ...item.provenance,
                source: 'user_confirmed',
                confidence: 'confirmed',
                trustTier: 'T1',
            },
        });
    }

    async correct(memoryId: string, text: string): Promise<MemoryItem | undefined> {
        const old = await this.get(memoryId);
        if (old === undefined) return undefined;
        await this.update(old, { status: 'deprecated' });
        return this.append(
            {
                kind: old.kind,
                text,
                userId: old.userId ?? 'local',
                ...(old.projectId !== undefined ? { projectId: old.projectId } : {}),
                ...(old.workspaceId !== undefined ? { workspaceId: old.workspaceId } : {}),
                ...(old.conversationId !== undefined ? { conversationId: old.conversationId } : {}),
                ...(old.rootGoalId !== undefined ? { rootGoalId: old.rootGoalId } : {}),
                ...(old.tags !== undefined ? { tags: old.tags } : {}),
                ...(old.importance !== undefined ? { importance: old.importance } : {}),
                ...(old.links !== undefined ? { links: old.links } : {}),
            },
            {
                source: 'user_explicit',
                confidence: 'confirmed',
                trustTier: 'T1',
                ref: memoryId,
            },
            [memoryId],
        );
    }

    async forget(memoryId: string): Promise<MemoryItem | undefined> {
        const item = await this.get(memoryId);
        if (item === undefined) return undefined;
        return this.update(item, { status: 'tombstoned' });
    }

    list(query: MemoryQuery): Promise<readonly MemoryItem[]> {
        return this.memory.recall(query);
    }

    private async append(
        input: MemoryWriteInput,
        provenance: MemoryProvenance,
        supersedes: readonly string[] = [],
    ): Promise<MemoryItem> {
        const base = {
            id: input.id ?? ulid(),
            kind: input.kind,
            text: input.text.trim(),
            createdAt: this.now(),
            userId: input.userId,
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
            ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
            ...(input.rootGoalId !== undefined ? { rootGoalId: input.rootGoalId } : {}),
            ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
            ...(input.importance !== undefined
                ? { importance: input.importance }
                : { importance: importanceOf(input.kind) }),
            ...(input.links !== undefined ? { links: input.links } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        } satisfies MemoryItem;
        const item: MemoryItem = {
            ...base,
            provenance: { ...input.provenance, ...provenance },
            status: 'active',
            contentHash: contentHash(base),
            version: 1,
            ...(supersedes.length > 0 ? { supersedes } : {}),
        };
        const existing = (await this.memory.all()).find(
            (candidate) =>
                candidate.userId === item.userId &&
                candidate.status === 'active' &&
                candidate.contentHash === item.contentHash,
        );
        const persisted = existing ?? item;
        if (existing === undefined) await this.memory.remember([item]);
        return persisted;
    }

    private async update(item: MemoryItem, patch: Partial<MemoryItem>): Promise<MemoryItem> {
        const updated: MemoryItem = {
            ...item,
            ...patch,
            provenance: { source: 'user', ...item.provenance, ...patch.provenance },
            version: (item.version ?? 1) + 1,
        };
        await this.memory.remember([updated]);
        return updated;
    }

    private async get(memoryId: string): Promise<MemoryItem | undefined> {
        return (await this.memory.all()).find((item) => item.id === memoryId);
    }
}
