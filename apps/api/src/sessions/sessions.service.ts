import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

/** Conversation 续聊时携带的最大历史轮数（防止上下文无界增长）。 */
const HISTORY_MAX_RUNS = 10;
/** 单条历史助手回答的截断上限（字符）。 */
const HISTORY_ANSWER_MAX_CHARS = 4000;

/**
 * SessionsService：Goal 会话（= 一棵 Goal 树）的创建/执行/详情/反馈编排。
 * C5 迁移后本层全部走 HarnessRuntime Goal 坐标系：sessionId 语义 = rootGoalId；
 * 领域与存储复用 @mazi/runtime，本层仅做编排与投影映射。
 */
@Injectable()
export class SessionsService {
    private readonly logger = new Logger('sessions');

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
        const history = conversationId ? await this.conversationHistory(conversationId) : [];
        const created = await this.runtime.harness().createGoalSession(input, {
            userId,
            ...(history.length > 0 ? { history } : {}),
        });
        this.logger.log(
            `createSession ${created.rootGoalId} input=${JSON.stringify(input.slice(0, 80))} user=${userId ?? '-'} workspace=${workspace ?? '-'}`,
        );
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

    /**
     * 组装同一 Conversation 的此前轮次（用户输入 + 助手最终回答）作为新 Session 的共享上下文。
     * 只取最近 HISTORY_MAX_RUNS 轮；助手回答截断，避免上下文无界增长。
     */
    private async conversationHistory(
        conversationId: string,
    ): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
        const runs = this.conversations.runs(conversationId).slice(-HISTORY_MAX_RUNS);
        const history: Array<{ role: 'user' | 'assistant'; text: string }> = [];
        for (const run of runs) {
            history.push({ role: 'user', text: run.input });
            const answer = await this.finalAnswerOf(run.rootGoalId);
            if (answer.length > 0) {
                history.push({ role: 'assistant', text: answer });
            }
        }
        return history;
    }

    /** 取一次 Goal run 的最终回答（最后一个 intent step 的正文）。 */
    private async finalAnswerOf(rootGoalId: string): Promise<string> {
        try {
            const snapshot = await this.runtime.harness().goalSnapshot(rootGoalId);
            const intents = snapshot.goals
                .flatMap((goal) => goal.tasks)
                .flatMap((task) => task.steps)
                .filter((step) => step.kind === 'intent');
            const last = intents[intents.length - 1];
            const text = last?.content ?? last?.payloadText ?? '';
            return text.length > HISTORY_ANSWER_MAX_CHARS
                ? text.slice(0, HISTORY_ANSWER_MAX_CHARS)
                : text;
        } catch {
            return '';
        }
    }

    /** POST /api/run：一站式创建 + 执行（Goal 树），进程内串行 */
    async runOnce(input: string, userId?: string) {
        this.logger.log(`runOnce input=${JSON.stringify(input.slice(0, 80))}`);
        const started = Date.now();
        const result = await this.runtime.runExclusive(() =>
            this.runtime.harness().runGoalSession(input, { userId }),
        );
        this.logger.log(
            `runOnce done ${result.rootGoalId} ms=${Date.now() - started} ok=${result.result.ok} tasks=${result.result.tasks.length}`,
        );
        return result;
    }

    /** POST /api/sessions/:id/run：执行已创建 Goal 会话（进程内串行，busy → 409） */
    async executeSession(sessionId: string) {
        this.logger.log(`executeSession ${sessionId}`);
        const started = Date.now();
        const result = await this.runtime.runExclusive(() =>
            this.runtime.harness().executeGoalTree(sessionId),
        );
        const last = result.tasks[result.tasks.length - 1];
        this.logger.log(
            `executeSession done ${sessionId} ms=${Date.now() - started} ok=${result.ok} tasks=${result.tasks.length} reason=${last?.reason ?? '-'} error=${JSON.stringify((last?.errorMessage ?? '').slice(0, 160))}`,
        );
        return result;
    }

    /** GET /api/sessions/:id（含 /:id/timeline）：Goal 树快照（goals/tasks/steps 四元组） */
    async sessionDetail(sessionId: string) {
        const snapshot = await this.runtime.harness().goalSnapshot(sessionId);
        if (snapshot.goals.length === 0) {
            throw new ApiError(404, 'session not found');
        }
        this.logger.debug(
            `sessionDetail ${sessionId} goals=${snapshot.goals.length} tasks=${snapshot.taskCount} steps=${snapshot.stepCount}`,
        );
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
        this.logger.log(
            `recordFeedback ${sessionId} type=${feedback.type} rating=${feedback.rating ?? '-'} content=${JSON.stringify((feedback.content ?? '').slice(0, 120))}`,
        );
        return { ok: true };
    }
}
