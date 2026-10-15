import 'reflect-metadata';
import type { ExperimentSpec, ExperimentView } from '@mazi/core';
import type { DefaultEventBus, ExperimentSummary, GoalTreeSnapshot } from '@mazi/runtime';
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
 * ExperimentsService —— AB 实验室编排（docs/AB测试设计.md §7/§8.2）。
 *
 * **独立性**：实验跑在专用运行时上（`ApiRuntimeService.experimentHarness`）——
 * 独立 Goal 库（`$MAZI_HOME/experiments/mazi.db`）、独立事件目录、独立串行锁；
 * 因此实验与主会话互不阻塞，Goal 树也互不可见（主会话 `/api/sessions/:id` 查不到实验 run）。
 *
 * 前台执行（不是后台任务）：
 *   POST /api/experiments          只建两臂 Goal 会话（arm.planned 携 rootGoalId），立即返回；
 *   POST /api/experiments/:id/run  前台并行跑完两臂（审批可经 /api/approvals/:id 现场应答）。
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
        const spec = this.freezeWorkspace(this.validate(body));
        return (await this.runner(spec.workspace)).create(spec);
    }

    /**
     * POST /api/experiments/:id/run：前台执行尚未完成的臂（并行）。
     * 已有实验在跑 → 409（实验专用锁）；两臂都已完成 → 幂等返回。
     * 主会话的串行锁不受影响 —— 实验在跑时主会话仍可跑任务。
     */
    async execute(experimentId: string): Promise<ExperimentView> {
        const view = await this.detail(experimentId);
        if (view.arms.every((arm) => arm.metrics !== undefined)) return view;
        const runner = await this.runner(view.workspace);
        const started = Date.now();
        const done = await this.runtime.runExperimentExclusive(() => runner.execute(experimentId));
        this.logger.log(
            `experiment ${done.experimentId} ${done.status} arms=${done.arms
                .map((arm) => arm.status)
                .join('/')} ms=${Date.now() - started}`,
        );
        return done;
    }

    /** POST /api/experiments/:id/rerun：复制为新的**待执行**实验（执行由前端前台触发）。 */
    async rerun(experimentId: string): Promise<ExperimentView> {
        const spec = this.freezeWorkspace(specOfExperiment(await this.detail(experimentId)));
        return (await this.runner(spec.workspace)).create(spec);
    }

    /** GET /api/experiments/:id/arms/:label/timeline：该臂 Goal 树快照（实验独立库，与主会话分开）。 */
    async armTimeline(experimentId: string, label: string): Promise<GoalTreeSnapshot> {
        const arm = await this.armOf(experimentId, label);
        const snapshot = await this.runtime
            .experimentHarness(arm.workspace)
            .goalSnapshot(arm.rootGoalId);
        if (snapshot.goals.length === 0) {
            throw new ApiError(404, '该臂尚无 Goal 事实（可能还没执行）');
        }
        return snapshot;
    }

    /** 该臂的事件总线 + rootGoalId（SSE 回放 / 实时订阅用）。 */
    async armBus(
        experimentId: string,
        label: string,
    ): Promise<{ bus: DefaultEventBus; rootGoalId: string }> {
        const arm = await this.armOf(experimentId, label);
        const harness = this.runtime.experimentHarness(arm.workspace);
        return { bus: harness.eventBus as DefaultEventBus, rootGoalId: arm.rootGoalId };
    }

    /**
     * POST /api/experiments/:id/stop：协作式终止（随时可停，`label` 缺省 = 两臂全停）。
     * 与主会话 stop 同语义：**不进串行锁**，运行中的臂在 Step 边界停止；
     * 尚未开始的臂直接记 aborted（之后不会再被 execute 拉起）。
     */
    async stop(
        experimentId: string,
        body: unknown,
    ): Promise<{ experimentId: string; stopping: string[]; view: ExperimentView }> {
        const label = asRecord(body).label;
        const view = await this.detail(experimentId);
        const runner = await this.runner(view.workspace);
        const stopping = await runner.cancel(
            experimentId,
            typeof label === 'string' && label.length > 0 ? label : undefined,
        );
        this.logger.log(
            `stop ${experimentId}${typeof label === 'string' ? ' arm=' + label : ''} stopping=${stopping.join(',') || '-'}`,
        );
        return { experimentId, stopping, view: await this.detail(experimentId) };
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

    /** DELETE /api/experiments/:id：删除实验日志（实验 Goal 存储与主会话都不级联删除）。 */
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

    private async runner(workspace?: string): Promise<ExperimentRunner> {
        const features = await this.runtime.features();
        return new ExperimentRunner({
            harness: this.runtime.experimentHarness(workspace),
            store: this.runtime.experiments(),
            featureResolver: (overrides) => features.resolve(overrides),
        });
    }

    private async armOf(
        experimentId: string,
        label: string,
    ): Promise<{ rootGoalId: string; workspace?: string }> {
        const view = await this.detail(experimentId);
        const arm = view.arms.find((candidate) => candidate.label === label);
        if (arm === undefined) throw new ApiError(404, '实验臂不存在：' + label);
        if (arm.rootGoalId === undefined) throw new ApiError(400, '该臂尚未创建 Goal 会话');
        return {
            rootGoalId: arm.rootGoalId,
            ...(view.workspace !== undefined ? { workspace: view.workspace } : {}),
        };
    }

    /**
     * 冻结生效工作区进 spec：显式选择优先，否则取当前选择（随心聊默认兜底）。
     * 冻结后实验可复现，且建会话 / 执行 / SSE 订阅解析到同一个实验运行时实例。
     */
    private freezeWorkspace(spec: ExperimentSpec): ExperimentSpec {
        if (spec.workspace !== undefined) return spec;
        const current = this.runtime.selectedWorkspaceRoot ?? this.runtime.freeChatWorkspace;
        return { ...spec, workspace: current };
    }
}
