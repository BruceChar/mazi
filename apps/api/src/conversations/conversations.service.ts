import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '@mazi/core';
import { ulid } from '@mazi/core';
import { Injectable } from '@nestjs/common';
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

    /** 新 Session 默认创建一个只含该 Session 的 Conversation */
    recordNewSession(input: NewConversationSession): void {
        this.read();
        const now = Date.now();
        this.state.conversations.push({
            conversationId: ulid(),
            title: input.title,
            userId: input.userId,
            sessionIds: [input.sessionId],
            workspace: input.workspace,
            projectId: input.projectId,
            createdAt: now,
            updatedAt: now,
        });
        this.write();
    }

    /** 迁移历史数据：旧 workspaces.json 里的 sessionIds 回填为 Conversation 记录 */
    private async backfillLegacySessions(): Promise<void> {
        this.read();
        const knownSessionIds = new Set(
            this.state.conversations.flatMap((conversation) => conversation.sessionIds),
        );
        const legacyBySession = new Map<string, { workspace?: string; projectId?: string }>();
        for (const project of this.runtime.projects()) {
            for (const sessionId of project.sessionIds) {
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
    }

    /** API 会话列表：记录按 updatedAt 倒序，水合 core Session 后返回 */
    async list(): Promise<Conversation[]> {
        await this.backfillLegacySessions();
        const records = [...this.state.conversations].sort(
            (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
        );
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
