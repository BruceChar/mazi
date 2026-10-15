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
 * 实验是方法记录：创建即执行（进程内串行锁），两臂顺序跑同一输入；
 * 状态与指标全部由实验日志折叠得出，本层不持有真相源。
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

    /** POST /api/experiments：定义并执行一次对照实验。 */
    async create(body: unknown): Promise<ExperimentView> {
        return this.execute(this.validate(body));
    }

    /** POST /api/experiments/:id/rerun：同一 spec 再跑一次（新 id，不覆盖原记录）。 */
    async rerun(experimentId: string): Promise<ExperimentView> {
        return this.execute(specOfExperiment(await this.detail(experimentId)));
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

    /**
     * 执行一次实验：进程内串行（复用 runExclusive，busy → 409）；spec.workspace 只
     * 在本次执行期间生效，结束后恢复宿主原工作区选择（实验不改用户上下文）。
     */
    private async execute(spec: ExperimentSpec): Promise<ExperimentView> {
        const previousWorkspace = this.runtime.selectedWorkspaceRoot;
        return this.runtime.runExclusive(async () => {
            const started = Date.now();
            try {
                if (spec.workspace !== undefined) this.runtime.setWorkspaceRoot(spec.workspace);
                const features = await this.runtime.features();
                const runner = new ExperimentRunner({
                    harness: this.runtime.harness(),
                    store: this.runtime.experiments(),
                    featureResolver: (overrides) => features.resolve(overrides),
                });
                const view = await runner.run(spec);
                this.logger.log(
                    `experiment ${view.experimentId} ${view.status} arms=${view.arms
                        .map((arm) => arm.status)
                        .join('/')} ms=${Date.now() - started}`,
                );
                return view;
            } finally {
                this.runtime.setWorkspaceRoot(previousWorkspace);
            }
        });
    }
}
