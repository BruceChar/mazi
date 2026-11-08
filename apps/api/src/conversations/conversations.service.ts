import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from '@mazi/core';
import type { Conversation, GoalRunRef } from '@mazi/libs';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { looksLikeWorkspacePath, normalizeWorkspacePath } from '../common/workspace-path.js';

interface ConversationsFile {
    conversations: Conversation[];
}

/**
 * 归一化单条 Conversation 的工作区归属（历史数据可能带尾斜杠）：
 * - workspace 一律归一化为无尾斜杠路径，保证与 workspaces.json 的 project.path 精确相等；
 * - projectId 仅当以绝对路径形式出现时才归一化；正常 hash 形式保持不变。
 * 返回是否发生了修改（用于一次性回写迁移）。
 */
function normalizeConversationWorkspace(conversation: Conversation): boolean {
    let changed = false;
    if (typeof conversation.workspace === 'string' && conversation.workspace.trim().length > 0) {
        const normalized = normalizeWorkspacePath(conversation.workspace);
        if (normalized !== conversation.workspace) {
            conversation.workspace = normalized;
            changed = true;
        }
    }
    if (
        typeof conversation.projectId === 'string' &&
        looksLikeWorkspacePath(conversation.projectId)
    ) {
        const normalized = normalizeWorkspacePath(conversation.projectId);
        if (normalized !== conversation.projectId) {
            conversation.projectId = normalized;
            changed = true;
        }
    }
    return changed;
}

/** recordNewSession / appendSession 入参（一次 Goal 会话的引用信息） */
export interface NewConversationRun {
    rootGoalId: string;
    input: string;
    /** 预生成的 Conversation id（调用方需在 createGoalSession 之前确定会话身份时使用）。 */
    conversationId?: string;
    userId?: string;
    workspace?: string;
    projectId?: string;
}

/**
 * Conversation 业务仓储（apps/api 层）：JSON 持久化会话分组与工作区归属。
 * Goal 坐标系：Conversation 仅保存 run 引用（rootGoalId + intake 输入 + 时间），
 * Goal 树本体与执行事实由 runtime goal-store 持久化；删除级联走 goalStore.deleteGoalTree。
 */
@Injectable()
export class ConversationsService {
    private readonly logger = new Logger('conversations');
    private state: ConversationsFile = { conversations: [] };

    constructor(private readonly runtime: ApiRuntimeService) {}

    private get file(): string {
        return join(this.runtime.homePaths.home, 'conversations.json');
    }

    private read(): void {
        let parsed: ConversationsFile;
        try {
            parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ConversationsFile;
        } catch {
            this.state = { conversations: [] };
            return;
        }
        const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
        // 一次性迁移：legacy workspace/projectId 的带尾斜杠形态归一化后回写，
        // 保证 WebUI 的 `workspace === project.path` 精确分组不再分裂。
        let changed = false;
        for (const conversation of conversations) {
            if (conversation === null || typeof conversation !== 'object') continue;
            if (normalizeConversationWorkspace(conversation)) changed = true;
        }
        this.state.conversations = conversations;
        if (changed) {
            this.write();
            this.logger.log('conversations.json migrated: workspace paths normalized');
        }
    }

    private write(): void {
        writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    }

    /** 新 Goal run 默认创建一个只含该 run 的 Conversation，返回 conversationId */
    recordNewRun(input: NewConversationRun): string {
        this.read();
        const conversationId = input.conversationId ?? ulid();
        const now = Date.now();
        // 写入即归一化：目录选择器可能传带尾斜杠的路径，避免再产生重复项目分组。
        const workspace =
            input.workspace !== undefined && input.workspace.trim().length > 0
                ? normalizeWorkspacePath(input.workspace)
                : undefined;
        const projectId =
            input.projectId !== undefined && looksLikeWorkspacePath(input.projectId)
                ? normalizeWorkspacePath(input.projectId)
                : input.projectId;
        this.state.conversations.push({
            conversationId,
            title: input.input.slice(0, 80),
            userId: input.userId,
            runs: [{ rootGoalId: input.rootGoalId, input: input.input, createdAt: now }],
            workspace,
            projectId,
            createdAt: now,
            updatedAt: now,
        });
        this.write();
        this.logger.log(
            `recordNewRun conversation=${conversationId} rootGoalId=${input.rootGoalId} title=${JSON.stringify(input.input.slice(0, 80))}`,
        );
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
        if (!conversation.runs.some((run: GoalRunRef) => run.rootGoalId === input.rootGoalId)) {
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
        this.logger.debug(
            `appendRun conversation=${conversationId} rootGoalId=${input.rootGoalId}`,
        );
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

    /** Resolve a root goal's conversation context for derived evaluation metadata. */
    runContext(rootGoalId: string):
        | {
              conversationId: string;
              title: string;
              input: string;
              userId?: string;
              workspace?: string;
              projectId?: string;
          }
        | undefined {
        this.read();
        for (const conversation of this.state.conversations) {
            const run = conversation.runs.find((item) => item.rootGoalId === rootGoalId);
            if (run === undefined) continue;
            return {
                conversationId: conversation.conversationId,
                title: conversation.title,
                input: run.input,
                ...(conversation.userId !== undefined ? { userId: conversation.userId } : {}),
                ...(conversation.workspace !== undefined
                    ? { workspace: conversation.workspace }
                    : {}),
                ...(conversation.projectId !== undefined
                    ? { projectId: conversation.projectId }
                    : {}),
            };
        }
        return undefined;
    }

    /** All persisted root goals with conversation metadata, used to backfill Eval. */
    allRuns(): Array<{
        rootGoalId: string;
        conversationId: string;
        title: string;
        userId?: string;
        workspace?: string;
        projectId?: string;
    }> {
        this.read();
        return this.state.conversations.flatMap((conversation) =>
            conversation.runs.map((run) => ({
                rootGoalId: run.rootGoalId,
                conversationId: conversation.conversationId,
                title: conversation.title,
                ...(conversation.userId !== undefined ? { userId: conversation.userId } : {}),
                ...(conversation.workspace !== undefined
                    ? { workspace: conversation.workspace }
                    : {}),
                ...(conversation.projectId !== undefined
                    ? { projectId: conversation.projectId }
                    : {}),
            })),
        );
    }

    /** 读取 Conversation 的 run 引用（按时间顺序），供续聊时组装共享上下文。 */
    runs(conversationId: string): GoalRunRef[] {
        this.read();
        const conversation = this.state.conversations.find(
            (item) => item.conversationId === conversationId,
        );
        if (!conversation) {
            throw new ApiError(404, 'conversation not found');
        }
        return conversation.runs;
    }

    /** 更新 Conversation 展示名或 */
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
        // 兼容调用方传入带/不带尾斜杠两种形式；read() 已归一化存量值，
        // 这里再按归一化比较一次（projectId 为路径形态的 legacy 数据也能解除）。
        const target = normalizeWorkspacePath(workspace);
        let detached = 0;
        for (const conversation of this.state.conversations) {
            const workspaceMatches =
                typeof conversation.workspace === 'string' &&
                normalizeWorkspacePath(conversation.workspace) === target;
            const projectIdMatches =
                conversation.workspace === undefined &&
                typeof conversation.projectId === 'string' &&
                looksLikeWorkspacePath(conversation.projectId) &&
                normalizeWorkspacePath(conversation.projectId) === target;
            if (!workspaceMatches && !projectIdMatches) continue;
            delete conversation.workspace;
            delete conversation.projectId;
            conversation.updatedAt = Date.now();
            detached++;
        }
        if (detached > 0) {
            this.write();
        }
        this.logger.log(
            `detachWorkspace workspace=${JSON.stringify(workspace)} detached=${detached} conversations`,
        );
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
            await this.runtime.harness().deleteFailures(run.rootGoalId);
        }
        this.logger.log(
            `remove conversation=${conversationId} runs=${conversation.runs.length} (goal trees cascaded)`,
        );
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
                    record.runs.some((run: GoalRunRef) => run.input.toLowerCase().includes(key)),
            );
        }
        const offset = Math.max(0, options.offset ?? 0);
        const limit = options.limit;
        records = records.slice(offset, limit === undefined ? undefined : offset + limit);
        this.logger.debug(
            `list offset=${offset} limit=${limit ?? '-'} q=${options.q ? JSON.stringify(options.q) : '-'} → ${records.length} conversations`,
        );
        return records;
    }
}
