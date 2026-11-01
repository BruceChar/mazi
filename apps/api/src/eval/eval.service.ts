import { randomUUID } from 'node:crypto';
import type { PermissionLevel } from '@mazi/core';
import {
    buildEvalReport,
    createRuntimeEvalExecutor,
    type EvalReport,
    type EvalTask,
    loadBaselineDataset,
    runEvalSuite,
} from '@mazi/eval';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

const PERMISSION_CEILINGS = new Set<PermissionLevel>([
    'read-only',
    'workspace-write',
    'draft',
    'approved',
]);

export type EvalRunStatus = 'running' | 'completed' | 'failed';

export interface EvalRunView {
    runId: string;
    status: EvalRunStatus;
    taskIds: string[];
    startedAt: number;
    completedAt?: number;
    modelId?: string;
    promptPackId?: string;
    workspace?: string;
    report?: EvalReport;
    error?: string;
}

function strings(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return undefined;
    }
    return value.map((item) => item.trim()).filter(Boolean);
}

@Injectable()
export class EvalService {
    private readonly baseline = loadBaselineDataset();
    private readonly runs = new Map<string, EvalRunView>();

    constructor(private readonly apiRuntime: ApiRuntimeService) {}

    tasks(): EvalTask[] {
        return this.baseline.map((task) => structuredClone(task));
    }

    listRuns(): EvalRunView[] {
        return [...this.runs.values()]
            .sort((left, right) => right.startedAt - left.startedAt)
            .map((run) => this.summary(run));
    }

    runDetail(runId: string): EvalRunView {
        const run = this.runs.get(runId);
        if (run === undefined) throw new ApiError(404, '评测运行不存在');
        return structuredClone(run);
    }

    report(runId: string): EvalReport {
        return this.runDetail(runId).report ?? this.incompleteReport(runId);
    }

    async run(body: Record<string, unknown>): Promise<EvalRunView> {
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

        const run: EvalRunView = {
            runId: randomUUID(),
            status: 'running',
            taskIds: selected.map((task) => task.id),
            startedAt: Date.now(),
            ...(modelId ? { modelId } : {}),
            ...(promptPackId ? { promptPackId } : {}),
            ...(workspace ? { workspace } : {}),
        };
        this.runs.set(run.runId, run);

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
            return structuredClone(run);
        } catch (error) {
            run.status = 'failed';
            run.completedAt = Date.now();
            run.error = error instanceof Error ? error.message : String(error);
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

    private summary(run: EvalRunView): EvalRunView {
        return {
            ...run,
            ...(run.report !== undefined ? { report: { ...run.report, results: [] } } : {}),
        };
    }

    private incompleteReport(runId: string): never {
        const run = this.runs.get(runId);
        if (run === undefined) throw new ApiError(404, '评测运行不存在');
        throw new ApiError(409, `评测运行尚未完成：${run.status}`);
    }
}
