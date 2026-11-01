import { randomUUID } from 'node:crypto';
import type { PermissionLevel } from '@mazi/core';
import {
    buildEvalReport,
    createRuntimeEvalExecutor,
    type EvalReport,
    type EvalRunRecord,
    type EvalRunStore,
    type EvalTask,
    loadBaselineDataset,
    MemoryEvalRunStore,
    MemorySessionEvaluationStore,
    projectSessionEvaluation,
    runEvalSuite,
    type SessionEvaluationFilter,
    type SessionEvaluationRecord,
    type SessionEvaluationStore,
    SqliteEvalRunStore,
    SqliteSessionEvaluationStore,
} from '@mazi/eval';
import type { GoalRunResult, HarnessRuntime } from '@mazi/runtime';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
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

@Injectable()
export class EvalService implements OnApplicationShutdown {
    private readonly baseline = loadBaselineDataset();
    private readonly runs: EvalRunStore;
    private readonly sessionEvaluationStore: SessionEvaluationStore;

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

    async listRuns(): Promise<EvalRunRecord[]> {
        return (await this.runs.list()).map((run) => this.summary(run));
    }

    async runDetail(runId: string): Promise<EvalRunRecord> {
        const run = await this.runs.get(runId);
        if (run === undefined) throw new ApiError(404, '评测运行不存在');
        return structuredClone(run);
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

    async run(body: Record<string, unknown>): Promise<EvalRunRecord> {
        const taskIds = strings(body.taskIds);
        const selected = this.selectTasks(taskIds);
        const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
        const promptPackId = typeof body.promptPackId === 'string' ? body.promptPackId.trim() : '';
        const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
        const rawCeiling = typeof body.permissionCeiling === 'string' ? body.permissionCeiling : '';
        if (rawCeiling && !PERMISSION_CEILINGS.has(rawCeiling as PermissionLevel)) {
            throw new ApiError(400, 'permissionCeiling 非法');
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
        };
        await this.runs.save(run);

        try {
            const executor = createRuntimeEvalExecutor(this.apiRuntime.harness(), {
                ...(rawCeiling ? { permissionCeiling: rawCeiling as PermissionLevel } : {}),
            });
            const results = await runEvalSuite(selected, executor, {
                ...(modelId ? { modelId } : {}),
                ...(promptPackId ? { promptPackId } : {}),
            });
            run.report = buildEvalReport(results);
            run.status = 'completed';
            run.completedAt = Date.now();
            await this.runs.save(run);
            return structuredClone(run);
        } catch (error) {
            run.status = 'failed';
            run.completedAt = Date.now();
            run.error = error instanceof Error ? error.message : String(error);
            await this.runs.save(run);
            throw error;
        }
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
