import 'reflect-metadata';
import type { ExperimentSpec, ExperimentView } from '@mazi/core';
import type { ExperimentSummary } from '@mazi/runtime';
import {
    appendExperimentReview,
    ExperimentRunner,
    ExperimentSpecError,
    listExperiments,
    loadExperiment,
    specOfExperiment,
    summarizeExperiment,
    validateExperimentSpec,
} from '@mazi/runtime';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function verdictOf(value: unknown): 'A' | 'B' | 'tie' | 'inconclusive' {
    return value === 'A' || value === 'B' || value === 'tie' || value === 'inconclusive'
        ? value
        : 'inconclusive';
}

/**
 * ExperimentsService —— 对照实验编排（docs/AB测试设计.md §7/§8.2）。
 *
 * 前台执行（不是后台任务）：
 *   POST /api/experiments          只建两臂 Goal 会话（arm.planned 携 rootGoalId），立即返回；
 *   POST /api/experiments/:id/run  在同一个进程内串行锁持有期内**并行**跑完两臂并返回。
 * 前端据此立刻打开两个窗口并订阅 /api/events/:rootGoalId，实时渲染并在需要时应答审批 ——
 * 执行面与主对话完全一致（createGoalSession / executeGoalTree / 事件总线 / 审批 seam）。
 */
@Injectable()
export class ExperimentsService {
    private readonly logger = new Logger('experiments');

    constructor(private readonly runtime: ApiRuntimeService) {}

    /** GET /api/experiments：历史列表（轻量投影，createdAt 倒序）。 */
    async list(): Promise<{ experiments: ExperimentSummary[] }> {
        const views = await listExperiments(this.runtime.experiments());
        return { experiments: views.map(summarizeExperiment) };
    }

    /** GET /api/experiments/:id：折叠后的完整视图（含指标 / 对比 / 复盘）。 */
    async detail(experimentId: string): Promise<ExperimentView> {
        const view = await loadExperiment(this.runtime.experiments(), experimentId);
        if (view === undefined) throw new ApiError(404, '实验不存在：' + experimentId);
        return view;
    }

    /** POST /api/experiments：创建实验（两臂会话就绪，不执行）。 */
    async create(body: unknown): Promise<ExperimentView> {
        const spec = this.validate(body);
        this.bindWorkspace(spec);
        return (await this.runner()).create(spec);
    }

    /**
     * POST /api/experiments/:id/run：前台执行尚未完成的臂（并行）。
     * 已有会话在跑 → 409（复用主对话的进程内串行锁）；两臂都已完成 → 幂等返回。
     */
    async execute(experimentId: string): Promise<ExperimentView> {
        const view = await this.detail(experimentId);
        if (view.arms.every((arm) => arm.metrics !== undefined)) return view;
        this.bindWorkspace(specOfExperiment(view));
        const runner = await this.runner();
        const started = Date.now();
        const done = await this.runtime.runExclusive(() => runner.execute(experimentId));
        this.logger.log(
            `experiment ${done.experimentId} ${done.status} arms=${done.arms
                .map((arm) => arm.status)
                .join('/')} ms=${Date.now() - started}`,
        );
        return done;
    }

    /** POST /api/experiments/:id/rerun：复制为新的**待执行**实验（执行由前端前台触发）。 */
    async rerun(experimentId: string): Promise<ExperimentView> {
        const previous = await this.detail(experimentId);
        const spec = specOfExperiment(previous);
        this.bindWorkspace(spec);
        return (await this.runner()).create(spec);
    }

    /** POST /api/experiments/:id/reviews：追加复盘备注（append-only）。 */
    async review(experimentId: string, body: unknown): Promise<ExperimentView> {
        const note = asRecord(body).note;
        if (typeof note !== 'string' || note.trim().length === 0) {
            throw new ApiError(400, '缺少 note');
        }
        const updated = await appendExperimentReview(
            this.runtime.experiments(),
            experimentId,
            note,
            verdictOf(asRecord(body).verdict),
        );
        if (updated === undefined) throw new ApiError(404, '实验不存在：' + experimentId);
        this.logger.log(`review ${experimentId} verdict=${verdictOf(asRecord(body).verdict)}`);
        return updated;
    }

    /** DELETE /api/experiments/:id：删除实验日志（Goal/Trace 事实不级联删除）。 */
    async remove(experimentId: string): Promise<{ ok: boolean; removed: boolean }> {
        const removed = await this.runtime.experiments().remove(experimentId);
        if (!removed) throw new ApiError(404, '实验不存在：' + experimentId);
        return { ok: true, removed };
    }

    private validate(body: unknown): ExperimentSpec {
        try {
            return validateExperimentSpec(body);
        } catch (error) {
            if (error instanceof ExperimentSpecError) throw new ApiError(400, error.message);
            throw error;
        }
    }

    private async runner(): Promise<ExperimentRunner> {
        const features = await this.runtime.features();
        return new ExperimentRunner({
            harness: this.runtime.harness(),
            store: this.runtime.experiments(),
            featureResolver: (overrides) => features.resolve(overrides),
        });
    }

    /**
     * 生效工作区：实验表单显式选择则切换「当前工作区」（与主对话一致 —— 选了就在该工作区跑），
     * 不指定则沿用当前选择。**不做执行后回滚**：回滚会让已开的 SSE 订阅落到另一个运行时实例。
     */
    private bindWorkspace(spec: ExperimentSpec): void {
        if (spec.workspace !== undefined) this.runtime.setWorkspaceRoot(spec.workspace);
    }
}
