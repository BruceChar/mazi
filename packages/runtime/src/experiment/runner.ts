/**
 * ExperimentRunner —— 对照实验执行器（docs/AB测试设计.md §7）。
 *
 * 语义：同一输入 / 同一工作区，两臂顺序执行（共享进程内执行锁与厂商配额，耗时仅作参考）；
 * 单臂失败不阻断另一臂；只改 variables 声明的自变量，其余运行参数来自实验定义时冻结的 baseline。
 * 实验事实全部落 ExperimentStore（append-only），执行器本身不持有状态。
 */

import type {
    EffectiveFeatures,
    ExperimentArmSpec,
    ExperimentMetrics,
    ExperimentSpec,
    ExperimentView,
} from '@mazi/core';
import { compareArms, ulid } from '@mazi/core';
import type { RunOptions } from '../harness/conversation.js';
import type { HarnessRuntime } from '../harness/index.js';
import { listExperiments, loadExperiment } from './fold.js';
import { collectMetrics, failedMetrics } from './metrics.js';
import type { ExperimentStore } from './store.js';
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

    /** 定义并执行一次实验（created → started → 两臂 → completed）。 */
    async run(spec: ExperimentSpec): Promise<ExperimentView> {
        const experimentId = ulid();
        await this.store.append(
            newExperimentEvent(experimentId, 'experiment.created', { spec }, this.now()),
        );
        await this.store.append(
            newExperimentEvent(experimentId, 'experiment.started', {}, this.now()),
        );
        try {
            const metrics = new Map<string, ExperimentMetrics>();
            for (const arm of spec.arms) {
                metrics.set(arm.label, await this.runArm(experimentId, spec, arm));
            }
            const first = spec.arms[0] as ExperimentArmSpec;
            const second = spec.arms[1] as ExperimentArmSpec;
            const comparison = compareArms(
                metrics.get(first.label) as ExperimentMetrics,
                metrics.get(second.label) as ExperimentMetrics,
            );
            await this.store.append(
                newExperimentEvent(
                    experimentId,
                    'experiment.completed',
                    { comparison },
                    this.now(),
                ),
            );
        } catch (error) {
            await this.store.append(
                newExperimentEvent(
                    experimentId,
                    'experiment.failed',
                    { error: error instanceof Error ? error.message : String(error) },
                    this.now(),
                ),
            );
            throw error;
        }
        const view = await loadExperiment(this.store, experimentId);
        if (view === undefined) throw new Error('实验日志写入后无法折叠：' + experimentId);
        return view;
    }

    /** 用同一 spec 再跑一次（新 experimentId，不覆盖原记录；用于观察方差）。 */
    async rerun(experimentId: string): Promise<ExperimentView | undefined> {
        const previous = await loadExperiment(this.store, experimentId);
        if (previous === undefined) return undefined;
        return this.run(specOfExperiment(previous));
    }

    /** 实验历史（createdAt 倒序）。 */
    history(): Promise<ExperimentView[]> {
        return listExperiments(this.store);
    }

    private async runArm(
        experimentId: string,
        spec: ExperimentSpec,
        arm: ExperimentArmSpec,
    ): Promise<ExperimentMetrics> {
        const resolved = this.resolveArm(spec, arm);
        const fields = {
            ...(resolved.skills !== undefined ? { skills: resolved.skills } : {}),
            ...(resolved.flags !== undefined ? { features: resolved.flags } : {}),
        };
        let rootGoalId: string | undefined;
        try {
            const created = await this.harness.createGoalSession(spec.input, resolved.options);
            rootGoalId = created.rootGoalId;
            await this.store.append(
                newExperimentEvent(
                    experimentId,
                    'arm.started',
                    { label: arm.label, rootGoalId, spec },
                    this.now(),
                ),
            );
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
            await this.store.append(
                newExperimentEvent(
                    experimentId,
                    'arm.ended',
                    { label: arm.label, status: armStatusOf(metrics), metrics },
                    this.now(),
                ),
            );
            return metrics;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const metrics = failedMetrics(message, fields);
            await this.store.append(
                newExperimentEvent(
                    experimentId,
                    'arm.ended',
                    { label: arm.label, status: 'failed', metrics, error: message },
                    this.now(),
                ),
            );
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
