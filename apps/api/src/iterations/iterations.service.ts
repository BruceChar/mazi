import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * IterationsService：TOC 冻结 → 独立 Agent 分析 → 反馈的 REST 编排。
 * 数据面与执行全部在 runtime 的 TocAnalyst（独立 SQLite + 独立 provider 调用）。
 */
@Injectable()
export class IterationsService {
    private readonly logger = new Logger('iterations');

    constructor(private readonly runtime: ApiRuntimeService) {}

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
}
