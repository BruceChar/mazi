/**
 * ExperimentRunner —— 对照实验执行器（docs/AB测试设计.md §7）。
 *
 * 执行语义与主对话一致：**建会话 → 前台执行 Goal 树 → 事件/SSE 实时可见 → 审批可应答**。
 * 因此拆成两步供 UI 使用：
 *   create(spec)  —— 只建两臂 Goal 会话（arm.planned 携 rootGoalId），前端据此立刻开两个窗口；
 *   execute(id)   —— 在同一个 runExclusive 持有期内**并行**跑完两臂（同一运行时、按 rootGoalId 隔离）。
 * run(spec) 保留为「创建 + 执行」的一次性入口（测试 / 无 UI 宿主）。
 * 单臂失败不阻断另一臂；事实全部落 ExperimentStore（append-only）。
 */

import type {
    EffectiveFeatures,
    ExperimentArmSpec,
    ExperimentArmState,
    ExperimentMetrics,
    ExperimentSpec,
    ExperimentView,
} from '@mazi/core';
import { compareArms, ulid } from '@mazi/core';
import type { RunOptions } from '../harness/conversation.js';
import type { HarnessRuntime } from '../harness/index.js';
import { listExperiments, loadExperiment } from './fold.js';
import { collectMetrics, failedMetrics } from './metrics.js';
import type { ExperimentEventType, ExperimentStore } from './store.js';
import { newExperimentEvent } from './store.js';

export interface ExperimentRunnerOptions {
    harness: HarnessRuntime;
    store: ExperimentStore;
    /**
     * Feature 解析器：把两臂合并后的开关取值解析为 EffectiveFeatures
     * （提示片段 / 技能集合 / 工具收窄）。缺省时开关只作审计记录，不影响运行。
     */
    featureResolver?: (overrides: Record<string, boolean>) => EffectiveFeatures;
    now?: () => number;
}

interface ResolvedArm {
    options: RunOptions;
    skills?: string[];
    flags?: Record<string, boolean>;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class ExperimentRunner {
    private readonly harness: HarnessRuntime;
    private readonly store: ExperimentStore;
    private readonly featureResolver?: (overrides: Record<string, boolean>) => EffectiveFeatures;
    private readonly now: () => number;

    constructor(options: ExperimentRunnerOptions) {
        this.harness = options.harness;
        this.store = options.store;
        this.featureResolver = options.featureResolver;
        this.now = options.now ?? Date.now;
    }

    /**
     * 定义实验（不执行）：为两臂各建一个 Goal 会话并写 arm.planned（含 rootGoalId）。
     * 返回的视图里两臂 status=pending —— 前端可立即为两个窗口订阅事件流。
     */
    async create(spec: ExperimentSpec): Promise<ExperimentView> {
        const experimentId = ulid();
        await this.append(experimentId, 'experiment.created', { spec });
        for (const arm of spec.arms) {
            const resolved = this.resolveArm(spec, arm);
            const created = await this.harness.createGoalSession(spec.input, resolved.options);
            await this.append(experimentId, 'arm.planned', {
                label: arm.label,
                rootGoalId: created.rootGoalId,
                spec,
            });
        }
        return this.view(experimentId);
    }

    /**
     * 前台执行尚未完成的臂（**并行**）：两臂在同一个 runExclusive 持有期内同时跑，
     * 与主对话共用 createGoalSession/executeGoalTree/事件总线/审批 seam；
     * 调用方（API）持有请求直到两臂结束，UI 期间通过 SSE 实时渲染并应答审批。
     */
    async execute(experimentId: string): Promise<ExperimentView> {
        const view = await this.view(experimentId);
        const spec = specOfExperiment(view);
        const pending = view.arms.filter(
            (arm) => arm.metrics === undefined && arm.rootGoalId !== undefined,
        );
        // 幂等：没有待执行臂时直接返回（不重复写 started，避免把终态改回 running）。
        if (pending.length > 0) {
            await this.append(experimentId, 'experiment.started', {});
            try {
                for (const arm of pending) {
                    await this.append(experimentId, 'arm.started', { label: arm.label });
                }
                await Promise.all(
                    pending.map(async (arm) => {
                        const resolved = this.resolveArm(spec, arm.spec);
                        await this.runArm(
                            experimentId,
                            arm.rootGoalId as string,
                            arm.label,
                            resolved,
                        );
                    }),
                );
            } catch (error) {
                await this.append(experimentId, 'experiment.failed', { error: messageOf(error) });
                throw error;
            }
        }
        const done = await this.view(experimentId);
        if (done.comparison === undefined && isComparable(done.arms)) {
            const comparison = compareArms(
                (done.arms[0] as ExperimentArmState).metrics as ExperimentMetrics,
                (done.arms[1] as ExperimentArmState).metrics as ExperimentMetrics,
            );
            await this.append(experimentId, 'experiment.completed', { comparison });
        }
        return this.view(experimentId);
    }

    /**
     * 协作式终止（随时可停，`label` 缺省 = 两臂全停）：
     * - 正在跑的臂 → `stopGoalTree`（Step 边界停止；该臂经正常路径落 aborted 指标）；
     * - 尚未开始跑的臂 → 直接落 aborted 指标，之后 `execute` 不会再把它拉起；
     * - 两臂都有指标后补写 experiment.completed（幂等）。
     * 返回实际收到停止信号（当时正在运行）的臂 label。
     */
    async cancel(experimentId: string, label?: string): Promise<string[]> {
        const view = await this.view(experimentId);
        const spec = specOfExperiment(view);
        const stopping: string[] = [];
        for (const arm of view.arms) {
            if (label !== undefined && arm.label !== label) continue;
            if (arm.rootGoalId === undefined || arm.metrics !== undefined) continue;
            if (this.harness.isGoalRunning(arm.rootGoalId)) {
                if (this.harness.stopGoalTree(arm.rootGoalId)) stopping.push(arm.label);
                continue;
            }
            const resolved = this.resolveArm(spec, arm.spec);
            const metrics = failedMetrics(
                '用户终止',
                {
                    ...(resolved.skills !== undefined ? { skills: resolved.skills } : {}),
                    ...(resolved.flags !== undefined ? { features: resolved.flags } : {}),
                },
                'aborted',
            );
            await this.append(experimentId, 'arm.ended', {
                label: arm.label,
                status: 'aborted',
                metrics,
                error: '用户终止',
            });
        }
        const done = await this.view(experimentId);
        if (done.comparison === undefined && isComparable(done.arms)) {
            const comparison = compareArms(
                (done.arms[0] as ExperimentArmState).metrics as ExperimentMetrics,
                (done.arms[1] as ExperimentArmState).metrics as ExperimentMetrics,
            );
            await this.append(experimentId, 'experiment.completed', { comparison });
        }
        return stopping;
    }

    /** 定义 + 前台执行（一次性；测试与无 UI 宿主用）。 */
    async run(spec: ExperimentSpec): Promise<ExperimentView> {
        const created = await this.create(spec);
        return this.execute(created.experimentId);
    }

    /** 复制为新的**待执行**实验（不执行：执行由前端前台触发；不覆盖原记录）。 */
    async rerun(experimentId: string): Promise<ExperimentView | undefined> {
        const previous = await loadExperiment(this.store, experimentId);
        if (previous === undefined) return undefined;
        return this.create(specOfExperiment(previous));
    }

    /** 实验历史（createdAt 倒序）。 */
    history(): Promise<ExperimentView[]> {
        return listExperiments(this.store);
    }

    private async view(experimentId: string): Promise<ExperimentView> {
        const view = await loadExperiment(this.store, experimentId);
        if (view === undefined) throw new Error('实验不存在：' + experimentId);
        return view;
    }

    private append(
        experimentId: string,
        type: ExperimentEventType,
        payload: Record<string, unknown>,
    ): Promise<void> {
        return this.store.append(newExperimentEvent(experimentId, type, payload, this.now()));
    }

    /** 单臂：执行 Goal 树 → 采集指标 → 落 arm.ended（异常隔离为该臂失败）。 */
    private async runArm(
        experimentId: string,
        rootGoalId: string,
        label: string,
        resolved: ResolvedArm,
    ): Promise<ExperimentMetrics> {
        const fields = {
            ...(resolved.skills !== undefined ? { skills: resolved.skills } : {}),
            ...(resolved.flags !== undefined ? { features: resolved.flags } : {}),
        };
        try {
            const startedAt = this.now();
            const result = await this.harness.executeGoalTree(rootGoalId);
            const endedAt = this.now();
            const snapshot = await this.harness.goalSnapshot(rootGoalId);
            const last = result.tasks[result.tasks.length - 1];
            const metrics = collectMetrics({
                snapshot,
                ok: result.ok,
                ...(last?.reason !== undefined ? { reason: last.reason } : {}),
                startedAt,
                endedAt,
                skills: resolved.skills ?? [],
                features: resolved.flags ?? {},
            });
            await this.append(experimentId, 'arm.ended', {
                label,
                status: armStatusOf(metrics),
                metrics,
            });
            return metrics;
        } catch (error) {
            const message = messageOf(error);
            const metrics = failedMetrics(message, fields);
            await this.append(experimentId, 'arm.ended', {
                label,
                status: 'failed',
                metrics,
                error: message,
            });
            return metrics;
        }
    }

    /**
     * 控制变量 + 该臂 delta → RunOptions。
     * 技能集合：显式臂技能 > baseline 快照；Feature 的 add 叠加、only 独占。
     * 工具白名单只来自 Feature 收窄（运行期再与配置白名单取交集）。
     */
    private resolveArm(spec: ExperimentSpec, arm: ExperimentArmSpec): ResolvedArm {
        const baseline = spec.baseline;
        const mergedFlags: Record<string, boolean> = {
            ...(baseline.features ?? {}),
            ...(arm.features ?? {}),
        };
        const effective = this.featureResolver?.(mergedFlags);

        const explicitSkills = arm.skills ?? baseline.skillIds;
        let skills: string[] | undefined =
            explicitSkills === undefined ? undefined : [...explicitSkills];
        if (effective !== undefined) {
            if (effective.skillMode === 'only') {
                skills = [...effective.skillIds];
            } else if (effective.skillIds.length > 0) {
                skills = [...new Set([...(skills ?? []), ...effective.skillIds])].sort();
            }
        }

        const flags =
            effective !== undefined && Object.keys(effective.values).length > 0
                ? { ...effective.values }
                : Object.keys(mergedFlags).length > 0
                  ? { ...mergedFlags }
                  : undefined;
        const promptFragment = effective?.promptFragment;
        const modelId = arm.modelId ?? baseline.modelId;
        const permissionCeiling = arm.permissionCeiling ?? baseline.permissionCeiling;
        const reasoningLevel =
            arm.reasoningLevel ?? effective?.reasoningLevel ?? baseline.reasoningLevel;

        const options: RunOptions = {
            ...(modelId !== undefined ? { modelId } : {}),
            ...(permissionCeiling !== undefined ? { permissionCeiling } : {}),
            ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
            ...(promptFragment !== undefined && promptFragment.length > 0
                ? { promptFragment }
                : {}),
            ...(skills !== undefined ? { skillIds: skills } : {}),
            ...(effective?.allowedTools !== undefined
                ? { allowedTools: effective.allowedTools }
                : {}),
            ...(flags !== undefined ? { flagOverrides: flags } : {}),
            ...(effective !== undefined ? { flagTrace: effective.trace } : {}),
        };
        return {
            options,
            ...(skills !== undefined ? { skills } : {}),
            ...(flags !== undefined ? { flags } : {}),
        };
    }
}

/** 两臂是否都拿到指标（可对比）。 */
function isComparable(arms: readonly ExperimentArmState[]): boolean {
    return arms.length === 2 && arms.every((arm) => arm.metrics !== undefined);
}

/** 指标 status → 臂状态（succeeded → completed）。 */
export function armStatusOf(metrics: ExperimentMetrics): 'completed' | 'failed' | 'aborted' {
    if (metrics.status === 'succeeded') return 'completed';
    return metrics.status === 'aborted' ? 'aborted' : 'failed';
}

/** 视图 → 可重跑的 spec（id/时间不进 spec）。 */
export function specOfExperiment(view: ExperimentView): ExperimentSpec {
    return {
        title: view.title,
        input: view.input,
        baseline: view.baseline,
        variables: view.variables,
        arms: view.arms.map((arm) => arm.spec),
        ...(view.hypothesis !== undefined ? { hypothesis: view.hypothesis } : {}),
        ...(view.workspace !== undefined ? { workspace: view.workspace } : {}),
    };
}
