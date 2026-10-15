import 'reflect-metadata';
import type { IterationStatus } from '@mazi/libs';
import { ITERATION_STATUSES, type UpdateIterationPatch } from '@mazi/runtime';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { SystemService } from '../system/system.service.js';

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isIterationStatus(value: unknown): value is IterationStatus {
    return typeof value === 'string' && (ITERATION_STATUSES as readonly string[]).includes(value);
}

/** tracker 领域错误 → HTTP 语义（404 未知记录 / 400 非法迁移）。 */
function mapTrackerError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('iteration not found')) return new ApiError(404, '迭代记录不存在');
    if (message.startsWith('invalid transition')) return new ApiError(400, message);
    return error instanceof Error ? error : new Error(message);
}

/**
 * IterationsService：TOC 冻结 → 独立 Agent 分析 → 反馈的 REST 编排。
 * 数据面与执行全部在 runtime 的 TocAnalyst（独立 SQLite + 独立 provider 调用）；
 * 迭代记录的版本快照由 SystemService 在 API 层注入。
 */
@Injectable()
export class IterationsService {
    private readonly logger = new Logger('iterations');

    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly system: SystemService,
    ) {}

    /** GET /api/iterations：toc + 其下分析 + 反馈的聚合视图。 */
    async list() {
        const iterations = await this.runtime.harness().tocAnalyst.listIterations();
        return { iterations };
    }

    /** POST /api/iterations/analyses：冻结/复用 toc 并跑一次分析。 */
    async analyze(body: Record<string, unknown>) {
        const taskId = asString(body.taskId);
        const rootGoalId = asString(body.rootGoalId);
        if (!taskId) throw new ApiError(400, '缺少 taskId');
        if (!rootGoalId) throw new ApiError(400, '缺少 rootGoalId');
        const modelId = asString(body.modelId);
        const tocId = asString(body.tocId);
        const result = await this.runtime.harness().tocAnalyst.analyze({
            taskId,
            rootGoalId,
            goalId: asString(body.goalId) ?? '',
            userInput: asString(body.userInput) ?? '',
            ...(modelId ? { modelId } : {}),
            ...(tocId ? { tocId } : {}),
        });
        this.logger.log(
            `analyze toc=${result.toc.tocId} analyze=${result.analysis.analyzeId} status=${result.analysis.status}`,
        );
        return result;
    }

    /** POST /api/iterations/:analyzeId/feedback：记录用户对某次分析的反馈。 */
    async addFeedback(analyzeId: string, body: Record<string, unknown>) {
        const content = asString(body.content);
        if (!content) throw new ApiError(400, '缺少 content');
        const rating = typeof body.rating === 'number' ? body.rating : undefined;
        const feedback = await this.runtime
            .harness()
            .tocAnalyst.addFeedback(analyzeId, { content, rating });
        this.logger.log(`feedback analyze=${analyzeId}`);
        return { feedback };
    }

    /** GET /api/iterations/records：迭代记录（updatedAt 倒序）。 */
    async listRecords() {
        const records = await this.runtime.harness().iterationTracker.list();
        return { records };
    }

    /** POST /api/iterations/records：新建记录；base = 服务端当前系统版本快照。 */
    async createRecord(body: Record<string, unknown>) {
        const title = asString(body.title);
        if (!title) throw new ApiError(400, '缺少 title');
        if (title.length > 200) throw new ApiError(400, 'title 过长');
        const intent = asString(body.intent);
        const analyzeId = asString(body.analyzeId);
        const tocId = asString(body.tocId);
        const record = await this.runtime.harness().iterationTracker.create({
            title,
            ...(intent ? { intent } : {}),
            ...(analyzeId ? { analyzeId } : {}),
            ...(tocId ? { tocId } : {}),
            base: this.system.readVersion(),
        });
        this.logger.log(`create record id=${record.iterationId}`);
        return { record };
    }

    /** PATCH /api/iterations/records/:iterationId：状态流转 + 文案修改。 */
    async updateRecord(iterationId: string, body: Record<string, unknown>) {
        const status = isIterationStatus(body.status) ? body.status : undefined;
        if (body.status !== undefined && status === undefined) {
            throw new ApiError(400, '无效状态');
        }
        const title = asString(body.title);
        const intent = asString(body.intent);
        const notes = typeof body.notes === 'string' ? body.notes : undefined;
        const patch: UpdateIterationPatch = {
            ...(status !== undefined ? { status } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(intent !== undefined ? { intent } : {}),
            ...(notes !== undefined ? { notes } : {}),
            // 标记已应用时注入当前版本：形成 base → applied 的版本差。
            ...(status === 'applied' ? { applied: this.system.readVersion() } : {}),
        };
        try {
            const record = await this.runtime.harness().iterationTracker.update(iterationId, patch);
            this.logger.log(`update record id=${iterationId} status=${record.status}`);
            return { record };
        } catch (error) {
            throw mapTrackerError(error);
        }
    }
}
