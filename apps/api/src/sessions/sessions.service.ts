import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

/**
 * SessionsService：Goal 会话（= 一棵 Goal 树）的创建/执行/详情/反馈编排。
 * C5 迁移后本层全部走 HarnessRuntime Goal 坐标系：sessionId 语义 = rootGoalId；
 * 领域与存储复用 @mazi/runtime，本层仅做编排与投影映射。
 */
@Injectable()
export class SessionsService {
    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly conversations: ConversationsService,
    ) {}

    /**
     * POST /api/sessions：创建 Goal 会话（intake + work，不执行）。
     * 返回 { sessionId(=rootGoalId), state, conversationId }，兼容既有 REST 形状。
     */
    async createSession(
        body: Record<string, unknown>,
    ): Promise<{ sessionId: string; state: string; conversationId: string }> {
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) {
            throw new ApiError(400, '缺少 input');
        }
        const conversationId =
            typeof body.conversationId === 'string' && body.conversationId.trim()
                ? body.conversationId.trim()
                : undefined;
        const targetContext = conversationId
            ? this.conversations.context(conversationId)
            : undefined;
        const bodyWorkspace =
            typeof body.workspace === 'string' && body.workspace.trim()
                ? body.workspace.trim()
                : typeof body.workspacePath === 'string' && body.workspacePath.trim()
                  ? body.workspacePath.trim()
                  : undefined;
        const resolvedWorkspaceRoot = targetContext?.workspace ?? bodyWorkspace;
        if (resolvedWorkspaceRoot !== undefined) {
            if (this.runtime.selectedWorkspaceRoot !== resolvedWorkspaceRoot) {
                this.runtime.setWorkspaceRoot(resolvedWorkspaceRoot);
            }
        } else if (this.runtime.selectedWorkspaceRoot !== undefined) {
            this.runtime.setWorkspaceRoot(undefined);
        }
        const workspace =
            targetContext?.workspace ?? bodyWorkspace ?? this.runtime.selectedWorkspaceRoot;
        const userId =
            (typeof body.userId === 'string' ? body.userId : undefined) ?? targetContext?.userId;
        const created = await this.runtime.harness().createGoalSession(input, { userId });
        const projectId =
            targetContext?.projectId ??
            (typeof body.projectId === 'string' && body.projectId.trim()
                ? body.projectId.trim()
                : workspace);
        const run = {
            rootGoalId: created.rootGoalId,
            input,
            userId,
            workspace,
            projectId,
        };
        let createdConversationId: string;
        if (conversationId) {
            this.conversations.appendRun(conversationId, run);
            createdConversationId = conversationId;
        } else {
            createdConversationId = this.conversations.recordNewRun(run);
        }
        return {
            sessionId: created.rootGoalId,
            state: 'active',
            conversationId: createdConversationId,
        };
    }

    /** POST /api/run：一站式创建 + 执行（Goal 树），进程内串行 */
    async runOnce(input: string, userId?: string) {
        return this.runtime.runExclusive(() =>
            this.runtime.harness().runGoalSession(input, { userId }),
        );
    }

    /** POST /api/sessions/:id/run：执行已创建 Goal 会话（进程内串行，busy → 409） */
    async executeSession(sessionId: string) {
        return this.runtime.runExclusive(() => this.runtime.harness().executeGoalTree(sessionId));
    }

    /** GET /api/sessions/:id（含 /:id/timeline）：Goal 树快照（goals/tasks/steps 四元组） */
    async sessionDetail(sessionId: string) {
        const snapshot = await this.runtime.harness().goalSnapshot(sessionId);
        if (snapshot.goals.length === 0) {
            throw new ApiError(404, 'session not found');
        }
        return { sessionId, ...snapshot };
    }

    /**
     * POST /api/sessions/:id/feedback：采集用户反馈，经 HarnessRuntime 同一事件总线
     * emit + flush（JSONL 双写完成后再应答，SSE 订阅者实时可见）。
     */
    async recordFeedback(
        sessionId: string,
        body: Record<string, unknown>,
    ): Promise<{ ok: boolean }> {
        const type =
            body.type === 'text_feedback'
                ? 'text_feedback'
                : body.type === 'decision_change'
                  ? 'decision_change'
                  : 'output_rating';
        const feedback = {
            timestamp: Date.now(),
            type,
            content: typeof body.content === 'string' ? body.content : undefined,
            rating: typeof body.rating === 'number' ? body.rating : undefined,
        };
        await this.runtime.harness().recordFeedback(sessionId, feedback);
        return { ok: true };
    }
}
