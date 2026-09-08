import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** recordNewSession / appendSession 入参（一次 Goal 会话的引用信息） */
export interface NewConversationRun {
    rootGoalId: string;
    input: string;
    userId?: string;
    workspace?: string;
    projectId?: string;
}

/**
 * 归一化历史 conversations.json：旧版记录以 sessionIds[] 承载（其 Session 数据已随 C5 迁移删除），
 * 保留会话壳（标题/归属/时间）并清空 run 引用，避免 list() 等按 runs[] 投影时崩溃。
 */
function normalizeRecords(records: ConversationRecord[]): ConversationRecord[] {
    return records.map((record) => {
        const next: ConversationRecord = {
            conversationId: record.conversationId,
            title: record.title,
            userId: record.userId,
            runs: Array.isArray(record.runs) ? record.runs : [],
            workspace: record.workspace,
            projectId: record.projectId,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            archived: record.archived,
        };
        return next;
    });
}

/**
 * Conversation 业务仓储（apps/api 层）：JSON 持久化会话分组与工作区归属。
 * Goal 坐标系：Conversation 仅保存 run 引用（rootGoalId + intake 输入 + 时间），
 * Goal 树本体与执行事实由 runtime goal-store 持久化；删除级联走 goalStore.deleteGoalTree。
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
            this.state.conversations = normalizeRecords(parsed.conversations ?? []);
        } catch {
            this.state.conversations = [];
        }
    }

    private write(): void {
        writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    }

    /** 新 Goal run 默认创建一个只含该 run 的 Conversation，返回 conversationId */
    recordNewRun(input: NewConversationRun): string {
        this.read();
        const conversationId = ulid();
        const now = Date.now();
        this.state.conversations.push({
            conversationId,
            title: input.input.slice(0, 80),
            userId: input.userId,
            runs: [{ rootGoalId: input.rootGoalId, input: input.input, createdAt: now }],
            workspace: input.workspace,
            projectId: input.projectId,
            createdAt: now,
            updatedAt: now,
        });
        this.write();
        return conversationId;
    }

    /** 把 Goal run 追加到已有 Conversation（同 conversation 内续聊） */
    appendRun(conversationId: string, input: NewConversationRun): void {
        this.read();
        const conversation = this.state.conversations.find(
            (item) => item.conversationId === conversationId,
        );
        if (!conversation) {
            throw new ApiError(404, 'conversation not found');
        }
        if (!conversation.runs.some((run) => run.rootGoalId === input.rootGoalId)) {
            conversation.runs.push({
                rootGoalId: input.rootGoalId,
                input: input.input,
                createdAt: Date.now(),
            });
        }
        if (conversation.userId === undefined && input.userId !== undefined) {
            conversation.userId = input.userId;
        }
        conversation.updatedAt = Date.now();
        this.write();
    }

    /** 查找 Conversation 的归属上下文（供创建追加 Goal run 时使用） */
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

    /** 删除工作区项目后：解除该项目下 Conversation 的归属（记录保留，回到普通会话区） */
    detachWorkspace(workspace: string): void {
        this.read();
        let changed = false;
        for (const conversation of this.state.conversations) {
            if (conversation.workspace === workspace) {
                conversation.workspace = undefined;
                conversation.projectId = undefined;
                conversation.updatedAt = Date.now();
                changed = true;
            }
        }
        if (changed) {
            this.write();
        }
    }

    /** 删除 Conversation，并级联删除其包含的 Goal 树（goal-store） */
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
        for (const run of conversation.runs) {
            await this.runtime.harness().goalStore.deleteGoalTree(run.rootGoalId);
        }
    }

    /** API 会话列表：按 updatedAt 倒序返回 run 引用（含最新 run）；支持分页与标题筛选 */
    async list(
        options: { limit?: number; offset?: number; q?: string } = {},
    ): Promise<Conversation[]> {
        // 每次读盘：服务常驻时 conversations.json 可能被外部/多实例改写
        this.read();
        let records = [...this.state.conversations].sort(
            (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
        );
        if (options.q?.trim()) {
            const key = options.q.trim().toLowerCase();
            records = records.filter(
                (record) =>
                    record.title.toLowerCase().includes(key) ||
                    record.runs.some((run) => run.input.toLowerCase().includes(key)),
            );
        }
        const offset = Math.max(0, options.offset ?? 0);
        const limit = options.limit;
        records = records.slice(offset, limit === undefined ? undefined : offset + limit);
        return records.map(conversationFromRecord);
    }
}
