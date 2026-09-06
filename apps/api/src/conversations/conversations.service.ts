import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@mazi/core';
import { ulid } from '@mazi/core';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import {
    type Conversation,
    type ConversationRecord,
    conversationFromRecord,
} from './conversation.js';

interface ConversationsFile {
    conversations: ConversationRecord[];
}

export interface NewConversationSession {
    sessionId: string;
    title: string;
    userId?: string;
    workspace?: string;
    projectId?: string;
}

/**
 * Conversation 业务仓储（apps/api 层）：JSON 持久化会话分组与工作区归属。
 * core Session 与 API Conversation 互相无反向引用，归属仅由本服务维护。
 */
@Injectable()
export class ConversationsService {
    private state: ConversationsFile = { conversations: [] };

    constructor(private readonly runtime: ApiRuntimeService) {}

    private get file(): string {
        return join(this.runtime.homePaths.home, 'conversations.json');
    }

    private read(): void {
        try {
            const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ConversationsFile;
            this.state.conversations = parsed.conversations ?? [];
        } catch {
            this.state.conversations = [];
        }
    }

    private write(): void {
        writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    }

    /** 新 Session 默认创建一个只含该 Session 的 Conversation，返回 conversationId */
    recordNewSession(input: NewConversationSession): string {
        this.read();
        const conversationId = ulid();
        const now = Date.now();
        this.state.conversations.push({
            conversationId,
            title: input.title,
            userId: input.userId,
            sessionIds: [input.sessionId],
            workspace: input.workspace,
            projectId: input.projectId,
            createdAt: now,
            updatedAt: now,
        });
        this.write();
        return conversationId;
    }

    /** 把 Session 追加到已有 Conversation（同 conversation 内续聊） */
    appendSession(conversationId: string, input: NewConversationSession): void {
        this.read();
        const conversation = this.state.conversations.find(
            (item) => item.conversationId === conversationId,
        );
        if (!conversation) {
            throw new ApiError(404, 'conversation not found');
        }
        if (!conversation.sessionIds.includes(input.sessionId)) {
            conversation.sessionIds.push(input.sessionId);
        }
        if (conversation.userId === undefined && input.userId !== undefined) {
            conversation.userId = input.userId;
        }
        conversation.updatedAt = Date.now();
        this.write();
    }

    /** 查找 Conversation 的归属上下文（供创建追加 Session 时使用） */
    context(conversationId: string): {
        userId?: string;
        workspace?: string;
        projectId?: string;
    } {
        this.read();
        const conversation = this.state.conversations.find(
            (item) => item.conversationId === conversationId,
        );
        if (!conversation) {
            throw new ApiError(404, 'conversation not found');
        }
        return {
            userId: conversation.userId,
            workspace: conversation.workspace,
            projectId: conversation.projectId,
        };
    }

    /** 更新 Conversation 展示名或归档状态 */
    update(conversationId: string, changes: { title?: string; archived?: boolean }): void {
        this.read();
        const conversation = this.state.conversations.find(
            (item) => item.conversationId === conversationId,
        );
        if (!conversation) {
            throw new ApiError(404, 'conversation not found');
        }
        if (changes.title !== undefined) {
            const title = changes.title.trim();
            if (!title) {
                throw new ApiError(400, '缺少 title');
            }
            conversation.title = title;
        }
        if (changes.archived !== undefined) {
            conversation.archived = changes.archived;
        }
        conversation.updatedAt = Date.now();
        this.write();
    }

    /** 删除 Conversation，并级联删除其包含的 core Session 数据 */
    async remove(conversationId: string): Promise<void> {
        this.read();
        const conversation = this.state.conversations.find(
            (item) => item.conversationId === conversationId,
        );
        if (!conversation) {
            throw new ApiError(404, 'conversation not found');
        }
        this.state.conversations = this.state.conversations.filter(
            (item) => item.conversationId !== conversationId,
        );
        this.write();
        for (const sessionId of conversation.sessionIds) {
            await this.runtime.harness().store.deleteSession(sessionId);
        }
    }

    /** 迁移历史数据：旧 workspaces.json 里的 sessionIds 回填为 Conversation 记录 */
    private async backfillLegacySessions(): Promise<void> {
        this.read();
        const knownSessionIds = new Set(
            this.state.conversations.flatMap((conversation) => conversation.sessionIds),
        );
        const legacyBySession = new Map<string, { workspace?: string; projectId?: string }>();
        for (const project of this.runtime.legacyProjects()) {
            for (const sessionId of project.sessionIds ?? []) {
                legacyBySession.set(sessionId, {
                    workspace: project.path,
                    projectId: project.path,
                });
            }
        }
        const records = await this.runtime.harness().store.listUserInteractionRecords();
        let added = false;
        for (const record of records) {
            if (knownSessionIds.has(record.sessionId)) {
                continue;
            }
            const legacy = legacyBySession.get(record.sessionId) ?? {};
            this.state.conversations.push({
                conversationId: ulid(),
                title: record.rawInput.slice(0, 80),
                userId: record.userId,
                sessionIds: [record.sessionId],
                workspace: legacy.workspace,
                projectId: legacy.projectId,
                createdAt: record.inputTimestamp,
                updatedAt: record.updatedAt,
            });
            added = true;
        }
        if (added) {
            this.write();
        }
        this.runtime.stripLegacyProjectSessionIds();
    }

    /** API 会话列表：按 updatedAt 倒序，水合 core Session 后返回；支持分页与标题筛选 */
    async list(
        options: { limit?: number; offset?: number; q?: string } = {},
    ): Promise<Conversation[]> {
        await this.backfillLegacySessions();
        let records = [...this.state.conversations].sort(
            (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
        );
        if (options.q?.trim()) {
            const key = options.q.trim().toLowerCase();
            records = records.filter((record) => record.title.toLowerCase().includes(key));
        }
        const offset = Math.max(0, options.offset ?? 0);
        const limit = options.limit;
        records = records.slice(offset, limit === undefined ? undefined : offset + limit);
        const hydrated: Conversation[] = [];
        for (const record of records) {
            const sessions: Session[] = [];
            for (const sessionId of record.sessionIds) {
                const session = await this.runtime.harness().store.loadSession(sessionId);
                if (session) {
                    sessions.push(session);
                }
            }
            hydrated.push(conversationFromRecord(record, sessions));
        }
        return hydrated;
    }
}
