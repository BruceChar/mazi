import { randomUUID } from 'node:crypto';
import type { PermissionLevel } from '@mazi/core';
import type { GoalRunResult, HarnessRuntime } from '@mazi/runtime';
import {
    buildEvalReport,
    createRuntimeEvalExecutor,
    type EvalReport,
    type EvalRunRecord,
    type EvalRunStore,
    type EvalRunTaskProgress,
    type EvalTask,
    type EvalTaskResult,
    loadBaselineDataset,
    MemoryEvalRunStore,
    MemorySessionEvaluationStore,
    projectSessionEvaluation,
    runEvalTask,
    type SessionEvaluationFilter,
    type SessionEvaluationRecord,
    type SessionEvaluationStore,
    SqliteEvalRunStore,
    SqliteSessionEvaluationStore,
} from '@mazi/runtime';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

const PERMISSION_CEILINGS = new Set<PermissionLevel>([
    'read-only',
    'workspace-write',
    'draft',
    'approved',
]);

function strings(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return undefined;
    }
    return value.map((item) => item.trim()).filter(Boolean);
}

/** 一次正在执行的 Benchmark 运行（进程内状态；落库快照见 EvalRunRecord）。 */
interface ActiveEvalRun {
    record: EvalRunRecord;
    tasks: EvalTask[];
    cancelledAll: boolean;
    executing: Promise<void> | null;
}

@Injectable()
export class EvalService implements OnApplicationShutdown, OnModuleInit {
    private readonly baseline = loadBaselineDataset();
    private readonly runs: EvalRunStore;
    private readonly sessionEvaluationStore: SessionEvaluationStore;
    /** runId → 运行中状态：逐任务进度、停止与恢复都基于它。 */
    private readonly active = new Map<string, ActiveEvalRun>();

    constructor(private readonly apiRuntime: ApiRuntimeService) {
        const dbPath = apiRuntime.homePaths?.dbPath;
        this.runs =
            dbPath !== undefined ? new SqliteEvalRunStore(dbPath) : new MemoryEvalRunStore();
        this.sessionEvaluationStore =
            dbPath !== undefined
                ? new SqliteSessionEvaluationStore(dbPath)
                : new MemorySessionEvaluationStore();
    }

    tasks(): EvalTask[] {
        return this.baseline.map((task) => structuredClone(task));
    }

    /**
     * 进程重启后没有真正的执行者：把上次残留的 running 运行收敛为 aborted，
     * 执行中的任务标 stopped（保留 rootGoalId），让用户可以从断点继续。
     */
    async onModuleInit(): Promise<void> {
        for (const run of await this.runs.list()) {
            if (run.status !== 'running') continue;
            const record = this.withProgress(structuredClone(run));
            for (const item of record.progress ?? []) {
                if (item.status === 'running' || item.status === 'stopping') {
                    item.status = 'stopped';
                }
            }
            record.status = 'aborted';
            await this.runs.save(record);
        }
    }

    async listRuns(): Promise<EvalRunRecord[]> {
        return (await this.runs.list()).map((run) => this.summary(this.withProgress(run)));
    }

    async runDetail(runId: string): Promise<EvalRunRecord> {
        const run = await this.runs.get(runId);
        if (run === undefined) throw new ApiError(404, '评测运行不存在');
        return structuredClone(this.withProgress(run));
    }

    async report(runId: string): Promise<EvalReport> {
        const run = await this.runDetail(runId);
        return run.report ?? this.incompleteReport(runId);
    }

    async recordSession(input: {
        harness: HarnessRuntime;
        rootGoalId: string;
        result?: GoalRunResult;
        title?: string;
        projectId?: string;
        workspace?: string;
        userId?: string;
        conversationId?: string;
        experimentId?: string;
        arm?: string;
        source?: 'session' | 'ab';
    }): Promise<SessionEvaluationRecord> {
        const snapshot = await input.harness.goalSnapshot(input.rootGoalId);
        const record = projectSessionEvaluation({
            rootGoalId: input.rootGoalId,
            snapshot,
            events: input.harness.eventBus.replay(input.rootGoalId),
            ...(input.result !== undefined ? { result: input.result } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
            ...(input.userId !== undefined ? { userId: input.userId } : {}),
            ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
            ...(input.experimentId !== undefined ? { experimentId: input.experimentId } : {}),
            ...(input.arm !== undefined ? { arm: input.arm } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
        });
        await this.sessionEvaluationStore.save(record);
        return record;
    }

    sessionEvaluations(filter: SessionEvaluationFilter = {}): Promise<SessionEvaluationRecord[]> {
        return this.sessionEvaluationStore.list(filter);
    }

    async sessionEvaluation(rootGoalId: string): Promise<SessionEvaluationRecord> {
        const record = await this.sessionEvaluationStore.get(rootGoalId);
        if (record === undefined) throw new ApiError(404, '会话评测不存在');
        return record;
    }

    async reconcileSessions(
        conversations: ReadonlyArray<{
            rootGoalId: string;
            conversationId: string;
            title: string;
            userId?: string;
            workspace?: string;
            projectId?: string;
        }>,
    ): Promise<{ reconciled: number; skipped: number }> {
        let reconciled = 0;
        let skipped = 0;
        for (const conversation of conversations) {
            try {
                await this.recordSession({
                    harness: this.apiRuntime.harness(),
                    rootGoalId: conversation.rootGoalId,
                    title: conversation.title,
                    conversationId: conversation.conversationId,
                    ...(conversation.userId !== undefined ? { userId: conversation.userId } : {}),
                    ...(conversation.workspace !== undefined
                        ? { workspace: conversation.workspace }
                        : {}),
                    ...(conversation.projectId !== undefined
                        ? { projectId: conversation.projectId }
                        : {}),
                });
                reconciled += 1;
            } catch {
                skipped += 1;
            }
        }
        return { reconciled, skipped };
    }

    /**
     * POST /api/eval/runs：创建运行并立刻返回逐任务进度。
     * 执行转后台；前端轮询 run 详情，并按每任务 rootGoalId 订阅 SSE 看实时过程。
     */
    async start(body: Record<string, unknown>): Promise<EvalRunRecord> {
        const taskIds = strings(body.taskIds);
        const selected = this.selectTasks(taskIds);
        const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
        const promptPackId = typeof body.promptPackId === 'string' ? body.promptPackId.trim() : '';
        const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
        const rawCeiling = typeof body.permissionCeiling === 'string' ? body.permissionCeiling : '';
        if (rawCeiling && !PERMISSION_CEILINGS.has(rawCeiling as PermissionLevel)) {
            throw new ApiError(400, 'permissionCeiling 非法');
        }
        if (this.active.size > 0) {
            throw new ApiError(409, '已有评测在运行，请先停止或等待完成');
        }
        if (workspace) this.apiRuntime.setWorkspaceRoot(workspace);

        const run: EvalRunRecord = {
            runId: randomUUID(),
            status: 'running',
            taskIds: selected.map((task) => task.id),
            startedAt: Date.now(),
            ...(modelId ? { modelId } : {}),
            ...(promptPackId ? { promptPackId } : {}),
            ...(workspace ? { workspace } : {}),
            ...(rawCeiling ? { permissionCeiling: rawCeiling as PermissionLevel } : {}),
            progress: selected.map((task) => ({
                taskId: task.id,
                title: task.title,
                status: 'pending' as const,
            })),
        };
        await this.runs.save(run);
        const active: ActiveEvalRun = {
            record: run,
            tasks: selected,
            cancelledAll: false,
            executing: null,
        };
        this.active.set(run.runId, active);
        // 先拍快照再启动后台执行：返回给前端的初始进度必须是全 pending。
        const snapshot = structuredClone(run);
        active.executing = this.executeRun(active);
        return snapshot;
    }

    /** 测试 / CLI 的阻塞语义：启动并等到运行收尾。 */
    async run(body: Record<string, unknown>): Promise<EvalRunRecord> {
        const started = await this.start(body);
        await this.active.get(started.runId)?.executing;
        return this.runDetail(started.runId);
    }

    /**
     * POST /api/eval/runs/:id/stop：协作式停止（taskId 缺省 = 全部）。
     * 正在跑的 Goal 在 Step 边界中止；停止的任务保留 rootGoalId，可 resume。
     */
    async stop(
        runId: string,
        body: Record<string, unknown>,
    ): Promise<{ runId: string; stopping: string[]; run: EvalRunRecord }> {
        const active = this.active.get(runId);
        const stored = active?.record ?? (await this.runs.get(runId));
        if (stored === undefined) throw new ApiError(404, '评测运行不存在');
        if (active === undefined || active.record.status !== 'running') {
            return {
                runId,
                stopping: [],
                run: structuredClone(this.withProgress(stored)),
            };
        }
        const harness = this.apiRuntime.harness();
        const taskId = typeof body.taskId === 'string' ? body.taskId : '';
        const stopping: string[] = [];
        const progress = active.record.progress ?? [];
        if (taskId) {
            const item = progress.find((candidate) => candidate.taskId === taskId);
            if (item === undefined) throw new ApiError(404, `任务不存在：${taskId}`);
            this.stopItem(harness, item, stopping);
        } else {
            active.cancelledAll = true;
            for (const item of progress) this.stopItem(harness, item, stopping);
        }
        await this.saveRun(active);
        return { runId, stopping, run: structuredClone(active.record) };
    }

    /**
     * POST /api/eval/runs/:id/resume：从已落库 Step 继续被停止的任务。
     * taskIds 缺省 = 所有 stopped/pending；已完成/失败的任务不动。
     */
    async resume(runId: string, body: Record<string, unknown>): Promise<EvalRunRecord> {
        if (this.active.get(runId)?.record.status === 'running') {
            throw new ApiError(409, '评测正在运行，不能重复恢复');
        }
        const stored = await this.runs.get(runId);
        if (stored === undefined) throw new ApiError(404, '评测运行不存在');
        const record = this.withProgress(structuredClone(stored));
        const taskIds = strings(body.taskIds);
        const byId = new Map(this.baseline.map((task) => [task.id, task]));
        const candidates = (record.progress ?? []).filter(
            (item) =>
                (item.status === 'stopped' ||
                    item.status === 'pending' ||
                    item.status === 'stopping') &&
                (taskIds === undefined || taskIds.includes(item.taskId)),
        );
        if (candidates.length === 0) throw new ApiError(400, '没有可恢复的任务');
        const tasks = candidates.flatMap((item) => {
            const task = byId.get(item.taskId);
            return task === undefined ? [] : [task];
        });
        for (const item of candidates) {
            // 保留 stopped 标记：executeRun 见 stopped + rootGoalId 才会走 resumeGoalTree。
            item.status = item.rootGoalId !== undefined ? 'stopped' : 'pending';
            item.endedAt = undefined;
            item.error = undefined;
        }
        record.status = 'running';
        record.completedAt = undefined;
        record.error = undefined;
        const active: ActiveEvalRun = {
            record,
            tasks,
            cancelledAll: false,
            executing: null,
        };
        this.active.set(runId, active);
        await this.saveRun(active);
        active.executing = this.executeRun(active);
        return structuredClone(record);
    }

    private stopItem(harness: HarnessRuntime, item: EvalRunTaskProgress, stopping: string[]): void {
        if (item.status === 'running' || item.status === 'stopping') {
            if (item.rootGoalId !== undefined && harness.stopGoalTree(item.rootGoalId)) {
                stopping.push(item.taskId);
            }
            // 会话还没建出来时也先标记：onSessionStarted 看到 stopping 会立刻中止。
            item.status = 'stopping';
            return;
        }
        if (item.status === 'pending') item.status = 'stopped';
    }

    private async executeRun(active: ActiveEvalRun): Promise<void> {
        try {
            const harness = this.apiRuntime.harness();
            const results: EvalTaskResult[] = [...(active.record.report?.results ?? [])];
            for (const task of active.tasks) {
                const item = this.itemOf(active, task.id);
                if (item === undefined) continue;
                if (item.status === 'completed' || item.status === 'failed') continue;
                if (active.cancelledAll) {
                    item.status = 'stopped';
                    continue;
                }
                if (item.status === 'stopping') {
                    item.status = 'stopped';
                    continue;
                }
                const resumeGoalId = item.status === 'stopped' ? item.rootGoalId : undefined;
                item.status = 'running';
                item.startedAt = item.startedAt ?? Date.now();
                item.endedAt = undefined;
                item.error = undefined;
                await this.saveRun(active);

                const executor = createRuntimeEvalExecutor(harness, {
                    ...(active.record.permissionCeiling !== undefined
                        ? { permissionCeiling: active.record.permissionCeiling }
                        : {}),
                    onSessionStarted: (taskId, rootGoalId) => {
                        const current = this.itemOf(active, taskId);
                        if (current !== undefined) current.rootGoalId = rootGoalId;
                        // 停止请求早于会话创建：拿到 rootGoalId 立刻中止，避免白跑。
                        if (active.cancelledAll || current?.status === 'stopping') {
                            harness.stopGoalTree(rootGoalId);
                        }
                        void this.saveRun(active);
                    },
                });
                const result = await runEvalTask(task, executor, {
                    ...(active.record.modelId !== undefined
                        ? { modelId: active.record.modelId }
                        : {}),
                    ...(active.record.promptPackId !== undefined
                        ? { promptPackId: active.record.promptPackId }
                        : {}),
                    ...(resumeGoalId !== undefined ? { resumeGoalId } : {}),
                });
                const aborted = result.observation.aborted === true;
                item.status = aborted ? 'stopped' : result.success ? 'completed' : 'failed';
                item.endedAt = Date.now();
                if (!aborted && !result.success) {
                    item.error = result.failureCategory ?? '未通过验收';
                }
                const index = results.findIndex((candidate) => candidate.task.id === task.id);
                if (index >= 0) results[index] = result;
                else results.push(result);
                await this.saveRun(active);
            }

            const stopped = (active.record.progress ?? []).some(
                (item) => item.status === 'stopped' || item.status === 'stopping',
            );
            active.record.status = stopped ? 'aborted' : 'completed';
            active.record.completedAt = Date.now();
            active.record.report = buildEvalReport(results);
            await this.saveRun(active);
        } catch (error) {
            active.record.status = 'failed';
            active.record.completedAt = Date.now();
            active.record.error = error instanceof Error ? error.message : String(error);
            await this.saveRun(active);
        } finally {
            this.active.delete(active.record.runId);
        }
    }

    private itemOf(active: ActiveEvalRun, taskId: string): EvalRunTaskProgress | undefined {
        return active.record.progress?.find((item) => item.taskId === taskId);
    }

    private async saveRun(active: ActiveEvalRun): Promise<void> {
        await this.runs.save(structuredClone(active.record));
    }

    /** 历史记录没有 progress 时，按 taskIds + report 回退投影。 */
    private withProgress(run: EvalRunRecord): EvalRunRecord {
        if (run.progress !== undefined) return run;
        const byId = new Map(this.baseline.map((task) => [task.id, task]));
        const done = new Set((run.report?.results ?? []).map((result) => result.task.id));
        const fallback: EvalRunTaskProgress[] = run.taskIds.map((taskId) => ({
            taskId,
            title: byId.get(taskId)?.title ?? taskId,
            status: done.has(taskId)
                ? 'completed'
                : run.status === 'running'
                  ? 'pending'
                  : run.status === 'failed'
                    ? 'failed'
                    : 'stopped',
        }));
        return { ...run, progress: fallback };
    }

    private selectTasks(taskIds: string[] | undefined): EvalTask[] {
        if (taskIds === undefined) return this.baseline;
        if (taskIds.length === 0) throw new ApiError(400, 'taskIds 不能为空');
        const byId = new Map(this.baseline.map((task) => [task.id, task]));
        const unknown = taskIds.filter((taskId) => !byId.has(taskId));
        if (unknown.length > 0) throw new ApiError(400, `未知评测任务：${unknown.join(', ')}`);
        return [...new Set(taskIds)].map((taskId) => byId.get(taskId) as EvalTask);
    }

    private summary(run: EvalRunRecord): EvalRunRecord {
        return {
            ...run,
            ...(run.report !== undefined ? { report: { ...run.report, results: [] } } : {}),
        };
    }

    private incompleteReport(runId: string): never {
        throw new ApiError(409, `评测运行尚未产生报告：${runId}`);
    }

    onApplicationShutdown(): void {
        this.runs.close();
        this.sessionEvaluationStore.close();
    }
}
