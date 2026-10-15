/**
 * 实验日志折叠 —— 从 append-only 事件重放出 ExperimentView（docs/AB测试设计.md §6）。
 *
 * 不变量：实验状态没有第二个真相源；view 的每个字段都能从日志行推导。损坏/未知事件
 * 被跳过（尽力而为），但 experiment.created 缺失即视为无此实验。
 */

import type {
    ExperimentArmSpec,
    ExperimentArmState,
    ExperimentComparison,
    ExperimentMetrics,
    ExperimentSpec,
    ExperimentVerdict,
    ExperimentView,
} from '@mazi/core';
import type { ExperimentEvent, ExperimentStore } from './store.js';
import { newExperimentEvent } from './store.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
}

/** 结构校验：created 事件由写入侧经 validateExperimentSpec 产生，这里只挡明显坏数据。 */
function asSpec(value: unknown): ExperimentSpec | undefined {
    const record = asRecord(value);
    if (record === undefined) return undefined;
    if (typeof record.title !== 'string' || typeof record.input !== 'string') return undefined;
    if (!Array.isArray(record.arms) || record.arms.length !== 2) return undefined;
    const arms = record.arms.filter((arm): arm is ExperimentArmSpec => {
        const item = asRecord(arm);
        return item !== undefined && typeof item.label === 'string';
    });
    if (arms.length !== 2) return undefined;
    return {
        title: record.title,
        input: record.input,
        baseline: (asRecord(record.baseline) ?? {}) as ExperimentSpec['baseline'],
        variables: Array.isArray(record.variables)
            ? (record.variables as ExperimentSpec['variables'])
            : [],
        arms,
        ...(typeof record.hypothesis === 'string' ? { hypothesis: record.hypothesis } : {}),
        ...(typeof record.workspace === 'string' ? { workspace: record.workspace } : {}),
    };
}

function armOf(view: ExperimentView, label: unknown): ExperimentArmState | undefined {
    return view.arms.find((arm) => arm.label === label);
}

function applyEvent(view: ExperimentView, event: ExperimentEvent): void {
    switch (event.type) {
        case 'experiment.started': {
            view.status = 'running';
            view.startedAt ??= event.at;
            return;
        }
        case 'arm.started': {
            const arm = armOf(view, event.payload.label);
            if (arm === undefined) return;
            if (typeof event.payload.rootGoalId === 'string') {
                arm.rootGoalId = event.payload.rootGoalId;
            }
            const spec = asSpec(event.payload.spec);
            if (spec !== undefined) {
                const exact = spec.arms.find((candidate) => candidate.label === arm.label);
                if (exact !== undefined) arm.spec = exact;
            }
            arm.status = 'running';
            arm.startedAt = event.at;
            return;
        }
        case 'arm.ended': {
            const arm = armOf(view, event.payload.label);
            if (arm === undefined) return;
            const status = event.payload.status;
            arm.status =
                status === 'completed' || status === 'failed' || status === 'aborted'
                    ? status
                    : 'failed';
            const metrics = asRecord(event.payload.metrics);
            if (metrics !== undefined) arm.metrics = metrics as unknown as ExperimentMetrics;
            if (typeof event.payload.error === 'string') arm.error = event.payload.error;
            arm.endedAt = event.at;
            return;
        }
        case 'experiment.completed': {
            const comparison = asRecord(event.payload.comparison);
            if (comparison !== undefined) {
                view.comparison = comparison as unknown as ExperimentComparison;
            }
            view.status = view.arms.some((arm) => arm.status === 'aborted')
                ? 'aborted'
                : 'completed';
            view.endedAt = event.at;
            return;
        }
        case 'experiment.failed': {
            view.status = 'failed';
            if (typeof event.payload.error === 'string') view.error = event.payload.error;
            view.endedAt = event.at;
            return;
        }
        case 'experiment.reviewed': {
            const note = typeof event.payload.note === 'string' ? event.payload.note : '';
            const verdict = event.payload.verdict;
            view.reviews.push({
                note,
                verdict:
                    verdict === 'A' ||
                    verdict === 'B' ||
                    verdict === 'tie' ||
                    verdict === 'inconclusive'
                        ? verdict
                        : 'inconclusive',
                at: event.at,
            });
            return;
        }
        default:
            return;
    }
}

/** 重放一个实验的日志；无 created 事件 → undefined。 */
export function foldExperiment(events: readonly ExperimentEvent[]): ExperimentView | undefined {
    const created = events.find((event) => event.type === 'experiment.created');
    if (created === undefined) return undefined;
    const spec = asSpec(created.payload.spec);
    if (spec === undefined) return undefined;
    const view: ExperimentView = {
        experimentId: created.experimentId,
        title: spec.title,
        ...(spec.hypothesis !== undefined ? { hypothesis: spec.hypothesis } : {}),
        input: spec.input,
        ...(spec.workspace !== undefined ? { workspace: spec.workspace } : {}),
        baseline: spec.baseline,
        variables: spec.variables,
        arms: spec.arms.map((arm) => ({ label: arm.label, spec: arm, status: 'pending' as const })),
        status: 'created',
        createdAt: created.at,
        reviews: [],
    };
    for (const event of events) applyEvent(view, event);
    return view;
}

/** 读取单个实验（折叠后的复盘视图）。 */
export async function loadExperiment(
    store: ExperimentStore,
    experimentId: string,
): Promise<ExperimentView | undefined> {
    return foldExperiment(await store.read(experimentId));
}

/** 列出全部实验：createdAt 倒序，其次 experimentId 倒序（稳定顺序）。 */
export async function listExperiments(store: ExperimentStore): Promise<ExperimentView[]> {
    const views = (await store.list())
        .map((events) => foldExperiment(events))
        .filter((view): view is ExperimentView => view !== undefined);
    return views.sort(
        (a, b) => b.createdAt - a.createdAt || (a.experimentId < b.experimentId ? 1 : -1),
    );
}

/** 追加复盘备注（append-only）；实验不存在 → undefined。 */
export async function appendExperimentReview(
    store: ExperimentStore,
    experimentId: string,
    note: string,
    verdict: ExperimentVerdict,
    at: number = Date.now(),
): Promise<ExperimentView | undefined> {
    const current = await loadExperiment(store, experimentId);
    if (current === undefined) return undefined;
    await store.append(
        newExperimentEvent(experimentId, 'experiment.reviewed', { note: note.trim(), verdict }, at),
    );
    return loadExperiment(store, experimentId);
}

/** 列表投影（轻量：不带输出全文与 Trace）。 */
export interface ExperimentSummary {
    experimentId: string;
    title: string;
    status: ExperimentView['status'];
    input: string;
    createdAt: number;
    endedAt?: number;
    variables: ExperimentView['variables'];
    arms: Array<{
        label: string;
        status: ExperimentArmState['status'];
        rootGoalId?: string;
        ok?: boolean;
        costUsd?: number;
        durationMs?: number;
    }>;
    reviewCount: number;
}

export function summarizeExperiment(view: ExperimentView): ExperimentSummary {
    return {
        experimentId: view.experimentId,
        title: view.title,
        status: view.status,
        input: view.input,
        createdAt: view.createdAt,
        ...(view.endedAt !== undefined ? { endedAt: view.endedAt } : {}),
        variables: view.variables,
        arms: view.arms.map((arm) => ({
            label: arm.label,
            status: arm.status,
            ...(arm.rootGoalId !== undefined ? { rootGoalId: arm.rootGoalId } : {}),
            ...(arm.metrics !== undefined
                ? {
                      ok: arm.metrics.ok,
                      costUsd: arm.metrics.costUsd,
                      durationMs: arm.metrics.durationMs,
                  }
                : {}),
        })),
        reviewCount: view.reviews.length,
    };
}
