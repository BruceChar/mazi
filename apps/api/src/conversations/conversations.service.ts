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

    /** API 会话列表：记录按 updatedAt 倒序，水合 core Session 后返回 */
    async list(): Promise<Conversation[]> {
        this.read();
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
