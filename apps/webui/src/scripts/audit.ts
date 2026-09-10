/**
 * audit —— 观测看板的纯计算层（docs/web/观测看板设计.md v2）。
 * 只做「快照/实时步骤 → 面板视图」投影：vendor / 输入估算 / 输出估算 / 成本双口径聚合、
 * 输入分段占比、逐步骤 context diff。无副作用，不依赖 Vue，便于单测。
 */

import type { GoalTreeSnapshot, StepRuntimeUsage, StepUsage } from '../types.ts';

// ============================================================
// Types
// ============================================================

/** 执行中的实时步骤（store.LiveStep 的审计子集）。 */
export interface AuditLiveStep {
    stepId: string;
    taskId: string;
    kind: string;
    toolName: string;
    content: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    usage?: StepUsage | null;
}

/** Context 装填的一段（环形图 / 图例）。 */
export interface AuditSegment {
    key: string;
    label: string;
    tokens: number;
    ratio: number;
    colorVar: string;
    /** 该段原文（截断；无可展示内容时为 ''） */
    content: string;
}

/** 成本聚合（vendor token 口径或估算 token 口径）。 */
export interface CostAggregate {
    total: number;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    reasoning: number;
    tier: string;
}

/** 估算聚合与漂移。 */
export interface EstimateAggregate {
    /** Σ 每轮 input 估算 */
    inputTotal: number;
    /** inputTotal − Σ vendor.input（有符号） */
    inputDrift: number | null;
    inputDriftRate: number | null;
    /** Σ 每轮 output 估算 */
    outputTotal: number;
    /** outputTotal − Σ (vendor.output − vendor.reasoning) */
    outputDrift: number | null;
    outputDriftRate: number | null;
}

/** 聚合后的用量事实。 */
export interface AggregatedUsage {
    vendor: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        reasoning: number;
        total: number;
    } | null;
    /** 最新一轮的 input 分段（用于占比环形图） */
    runtime: StepRuntimeUsage | null;
    estimate: EstimateAggregate | null;
    cost: CostAggregate | null;
    estimatedCost: CostAggregate | null;
    timing: { ttftMs: number; totalMs: number; tokensPerSecond: number } | null;
}

/** 步骤明细行（Task/Run 级逐步骤 context diff）。 */
export interface AuditStepRow {
    stepId: string;
    /** 会话流中的全局序号（1-based，跨 run/task/step） */
    lineIndex: number;
    /** 所属 run 序号（1-based） */
    runIndex: number;
    index: number;
    kind: string;
    toolName: string;
    status: string;
    durationMs: number | null;
    tokens: number;
    contextTotal: number | null;
    contextDelta: number | null;
    /** 相对上一步新增的上下文内容（截断；可在 Context 追踪里展开） */
    diffContent: string;
    selected: boolean;
}

/** Step 级 context diff。 */
export interface AuditDiff {
    delta: number;
    from: number;
    to: number;
}

/** 成本漂移。 */
export interface CostDrift {
    usd: number;
    rate: number | null;
}

/** 面板视图。 */
export interface AuditView {
    kind: 'step' | 'task' | 'conversation' | 'none';
    stale: boolean;
    title: string;
    subtitle: string;
    usage: AggregatedUsage;
    segments: AuditSegment[];
    utilization: number | null;
    diff: AuditDiff | null;
    strategies: string[];
    budgetPressureAction: string;
    rows: AuditStepRow[];
    /** 相对上一轮新增内容（截断；无可展示内容时为 ''） */
    diffContent: string;
    /** 估算成本 − vendor 成本 */
    costDrift: CostDrift | null;
    /** Σ估算总量（input+output） */
    estimatedTotal: number | null;
    /** Σvendor total */
    vendorTotal: number | null;
}

/** 一个 run（Session）及其快照，按 Conversation 内时间顺序。 */
export interface AuditRunInput {
    rootGoalId: string;
    input?: string;
    snapshot: GoalTreeSnapshot | null;
}

export interface AuditInput {
    /** 当前 Conversation 的全部 run（按时间顺序）；缺省回落到单 snapshot。 */
    runs?: AuditRunInput[];
    snapshot?: GoalTreeSnapshot | null;
    liveSteps?: AuditLiveStep[];
    stepId?: string;
    taskId?: string;
    /** Conversation 展示名（会话汇总用）。 */
    conversationTitle?: string;
}

interface ResolvedStep {
    stepId: string;
    taskId: string;
    goalId: string;
    runIndex: number;
    runInput: string;
    taskIndex: number;
    taskTitle: string;
    index: number;
    kind: string;
    toolName: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    usage: StepUsage | null;
    text: string;
    /** 相对上一轮新增的上下文内容（截断） */
    diffContent: string;
    /** 会话流中的全局序号（collectRows 结束后赋值） */
    lineIndex: number;
    /** 会话流中相对上一步的上下文 delta / 上一步总量（collectRows 结束后赋值） */
    contextDelta: number | null;
    previousContextTotal: number | null;
}

interface UsageBearingStep {
    startedAt: number;
    usage?: StepUsage | null;
}

// ============================================================
// Aggregation
// ============================================================

function addCost(current: CostAggregate | null, next: StepUsage['cost']): CostAggregate {
    const base: CostAggregate = current ?? {
        total: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        reasoning: 0,
        tier: '',
    };
    if (!next) {
        return base;
    }
    base.total += next.totalCostUsd ?? 0;
    base.input += next.inputCostUsd ?? 0;
    base.output += next.outputCostUsd ?? 0;
    base.cacheWrite += next.cacheWriteCostUsd ?? 0;
    base.cacheRead += next.cacheReadCostUsd ?? 0;
    base.reasoning += next.reasoningCostUsd ?? 0;
    if (next.priceTierApplied) {
        base.tier = next.priceTierApplied;
    }
    return base;
}

/** 多步用量聚合：vendor/cost/estimate 求和；runtime 取时间最新一轮；timing 求和 + TTFT 平均。 */
export function aggregateUsage(steps: UsageBearingStep[]): AggregatedUsage {
    let vendor: AggregatedUsage['vendor'] = null;
    let cost: CostAggregate | null = null;
    let estimatedCost: CostAggregate | null = null;
    let runtime: StepRuntimeUsage | null = null;
    let runtimeAt = Number.NEGATIVE_INFINITY;
    let estimateInput = 0;
    let estimateOutput = 0;
    let hasEstimate = false;
    let vendorInput = 0;
    let vendorOutputNonReasoning = 0;
    let totalMs = 0;
    let ttftSum = 0;
    let ttftCount = 0;
    let outputTokens = 0;
    let hasTiming = false;
    for (const step of steps) {
        const usage = step.usage;
        if (!usage) continue;
        if (usage.vendor) {
            if (!vendor) {
                vendor = {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheCreation: 0,
                    reasoning: 0,
                    total: 0,
                };
            }
            const input = usage.vendor.inputTokens ?? 0;
            const output = usage.vendor.outputTokens ?? 0;
            const reasoning = usage.vendor.reasoningOutputTokens ?? 0;
            vendor.input += input;
            vendor.output += output;
            vendor.cacheRead += usage.vendor.cacheReadInputTokens ?? 0;
            vendor.cacheCreation += usage.vendor.cacheCreationInputTokens ?? 0;
            vendor.reasoning += reasoning;
            vendor.total += input + output;
            vendorInput += input;
            vendorOutputNonReasoning += Math.max(0, output - reasoning);
        }
        if (usage.cost) cost = addCost(cost, usage.cost);
        if (usage.estimatedCost) estimatedCost = addCost(estimatedCost, usage.estimatedCost);
        if (usage.runtime) {
            estimateInput += usage.runtime.totalContextTokens ?? 0;
            hasEstimate = true;
            if (step.startedAt >= runtimeAt) {
                runtime = usage.runtime;
                runtimeAt = step.startedAt;
            }
        }
        if (usage.estimate) {
            estimateOutput += usage.estimate.outputTokens ?? 0;
            hasEstimate = true;
        }
        if (usage.timing) {
            hasTiming = true;
            totalMs += usage.timing.totalMs ?? 0;
            ttftSum += usage.timing.ttftMs ?? 0;
            ttftCount += 1;
            outputTokens += usage.vendor?.outputTokens ?? 0;
        }
    }
    const estimate: EstimateAggregate | null = hasEstimate
        ? {
              inputTotal: estimateInput,
              inputDrift: vendor ? estimateInput - vendorInput : null,
              inputDriftRate:
                  vendor && vendorInput > 0 ? (estimateInput - vendorInput) / vendorInput : null,
              outputTotal: estimateOutput,
              outputDrift: vendor ? estimateOutput - vendorOutputNonReasoning : null,
              outputDriftRate:
                  vendor && vendorOutputNonReasoning > 0
                      ? (estimateOutput - vendorOutputNonReasoning) / vendorOutputNonReasoning
                      : null,
          }
        : null;
    const timing = hasTiming
        ? {
              ttftMs: ttftCount > 0 ? ttftSum / ttftCount : 0,
              totalMs,
              tokensPerSecond:
                  outputTokens > 0 && totalMs - ttftSum > 0
                      ? (outputTokens / (totalMs - ttftSum)) * 1000
                      : 0,
          }
        : null;
    return { vendor, runtime, estimate, cost, estimatedCost, timing };
}

// ============================================================
// Context segments
// ============================================================

const OPTIONAL_SEGMENTS = new Set(['retrieved', 'example']);

interface SegmentDef {
    key: string;
    label: string;
    colorVar: string;
    pick: (runtime: StepRuntimeUsage) => number;
}

function segmentDefs(runtime: StepRuntimeUsage): SegmentDef[] {
    const defs: SegmentDef[] = [
        {
            key: 'system',
            label: 'system prompt',
            colorVar: '--seg-system',
            pick: (r) => r.systemPromptTokens ?? 0,
        },
    ];
    const hasSplit =
        runtime.historyUserTokens !== undefined ||
        runtime.historyAssistantTokens !== undefined ||
        runtime.toolCallTokens !== undefined;
    if (hasSplit) {
        defs.push({
            key: 'historyUser',
            label: 'user history',
            colorVar: '--seg-user',
            pick: (r) => r.historyUserTokens ?? 0,
        });
        defs.push({
            key: 'historyAssistant',
            label: 'assistant',
            colorVar: '--seg-assistant',
            pick: (r) => r.historyAssistantTokens ?? 0,
        });
        defs.push({
            key: 'toolCall',
            label: 'tool-call args',
            colorVar: '--seg-toolcall',
            pick: (r) => r.toolCallTokens ?? 0,
        });
    } else if ((runtime.historyTokens ?? 0) > 0) {
        defs.push({
            key: 'history',
            label: 'history',
            colorVar: '--seg-user',
            pick: (r) => r.historyTokens ?? 0,
        });
    }
    defs.push({
        key: 'toolSchema',
        label: 'tool schema',
        colorVar: '--seg-schema',
        pick: (r) => r.toolSchemaTokens ?? 0,
    });
    defs.push({
        key: 'newInput',
        label: 'user input',
        colorVar: '--seg-input',
        pick: (r) => r.newInputTokens ?? 0,
    });
    defs.push({
        key: 'observation',
        label: 'observation',
        colorVar: '--seg-observation',
        pick: (r) => r.observationTokens ?? 0,
    });
    defs.push({
        key: 'retrieved',
        label: 'retrieved',
        colorVar: '--seg-optional',
        pick: (r) => r.retrievedTokens ?? 0,
    });
    defs.push({
        key: 'example',
        label: 'examples',
        colorVar: '--seg-optional',
        pick: (r) => r.exampleTokens ?? 0,
    });
    return defs;
}

/** 段 key → contents 字段（history 单段特殊处理）。 */
const SEGMENT_CONTENT_KEY: Record<string, keyof NonNullable<StepRuntimeUsage['contents']>> = {
    system: 'systemPrompt',
    historyUser: 'historyUser',
    historyAssistant: 'historyAssistant',
    toolCall: 'toolCalls',
    toolSchema: 'toolSchema',
    newInput: 'newInput',
    observation: 'observation',
    retrieved: 'retrieved',
    example: 'examples',
};

function segmentContent(runtime: StepRuntimeUsage, key: string): string {
    const contents = runtime.contents;
    if (!contents) return '';
    if (key === 'history') {
        return [contents.historyUser, contents.historyAssistant, contents.toolCalls]
            .filter((part) => part.length > 0)
            .join('\n\n');
    }
    const contentKey = SEGMENT_CONTENT_KEY[key];
    return contentKey ? (contents[contentKey] ?? '') : '';
}

/** Runtime input 分段 → 占比段（分母 totalContextTokens，缺省回落分段和）。 */
export function contextSegments(runtime: StepRuntimeUsage | null | undefined): AuditSegment[] {
    if (!runtime) return [];
    const defs = segmentDefs(runtime);
    const sum = defs.reduce((total, def) => total + def.pick(runtime), 0);
    const denominator =
        (runtime.totalContextTokens ?? 0) > 0 ? (runtime.totalContextTokens ?? 0) : sum;
    return defs
        .filter((def) => !OPTIONAL_SEGMENTS.has(def.key) || def.pick(runtime) > 0)
        .map((def) => {
            const tokens = def.pick(runtime);
            return {
                key: def.key,
                label: def.label,
                tokens,
                ratio: denominator > 0 ? tokens / denominator : 0,
                colorVar: def.colorVar,
                content: segmentContent(runtime, def.key),
            };
        });
}

/** 非零段保底最小扇区（占比），避免小占比在饼图里不可见。 */
export const DONUT_MIN_SHARE = 0.03;

/**
 * 环形图各段扇区占比：按显示段 token 之和归一化，并对非零段保底 minShare
 * （其余段按比例回缩）。返回数组与 segments 一一对应；0 token 段为 0。
 */
export function donutShares(segments: AuditSegment[], minShare = DONUT_MIN_SHARE): number[] {
    const total = segments.reduce((sum, seg) => sum + Math.max(0, seg.tokens), 0);
    if (total <= 0) return segments.map(() => 0);
    let current = segments.map((seg) => (seg.tokens > 0 ? seg.tokens / total : 0));
    for (let iter = 0; iter < 4; iter += 1) {
        const below = current
            .map((value, index) => (value > 0 && value < minShare ? index : -1))
            .filter((index) => index >= 0);
        if (below.length === 0) break;
        const floorSum = below.length * minShare;
        if (floorSum >= 1) break;
        const restSum = current.reduce(
            (sum, value, index) => (below.includes(index) ? sum : sum + value),
            0,
        );
        if (restSum <= 0) break;
        const budget = 1 - floorSum;
        current = current.map((value, index) =>
            below.includes(index) ? minShare : (value / restSum) * budget,
        );
    }
    return current;
}

/** SVG 环形扇区（hover 高亮 / tooltip 用）。 */
export interface DonutArc extends AuditSegment {
    /** SVG path（viewBox 0 0 100 100） */
    path: string;
    /** 中角方向偏移（单位：user unit，用于 hover 向外突出） */
    offset: { x: number; y: number };
}

const DONUT_OUTER = 46;
const DONUT_INNER = 28;
const DONUT_LIFT = 4;

function donutPoint(radius: number, fraction: number): { x: number; y: number } {
    const angle = fraction * Math.PI * 2 - Math.PI / 2;
    return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
}

const round3 = (value: number): string => value.toFixed(3);

function donutArcPath(startFraction: number, endFraction: number): string {
    const outer = DONUT_OUTER;
    const inner = DONUT_INNER;
    const sweep = (endFraction - startFraction) * Math.PI * 2;
    if (sweep >= Math.PI * 2 - 1e-6) {
        // 整圆：两段半环（外顺内逆）形成圆环
        const top = donutPoint(outer, 0);
        const bottom = donutPoint(outer, 0.5);
        const iTop = donutPoint(inner, 0);
        const iBottom = donutPoint(inner, 0.5);
        return [
            `M ${round3(top.x)} ${round3(top.y)}`,
            `A ${outer} ${outer} 0 1 1 ${round3(bottom.x)} ${round3(bottom.y)}`,
            `A ${outer} ${outer} 0 1 1 ${round3(top.x)} ${round3(top.y)}`,
            'Z',
            `M ${round3(iTop.x)} ${round3(iTop.y)}`,
            `A ${inner} ${inner} 0 1 0 ${round3(iBottom.x)} ${round3(iBottom.y)}`,
            `A ${inner} ${inner} 0 1 0 ${round3(iTop.x)} ${round3(iTop.y)}`,
            'Z',
        ].join(' ');
    }
    const p1 = donutPoint(outer, startFraction);
    const p2 = donutPoint(outer, endFraction);
    const p3 = donutPoint(inner, endFraction);
    const p4 = donutPoint(inner, startFraction);
    const large = sweep > Math.PI ? 1 : 0;
    return [
        `M ${round3(p1.x)} ${round3(p1.y)}`,
        `A ${outer} ${outer} 0 ${large} 1 ${round3(p2.x)} ${round3(p2.y)}`,
        `L ${round3(p3.x)} ${round3(p3.y)}`,
        `A ${inner} ${inner} 0 ${large} 0 ${round3(p4.x)} ${round3(p4.y)}`,
        'Z',
    ].join(' ');
}

/** 占比段 → SVG 环形扇区（与 donutShares 同口径；0 token 段不产出）。 */
export function donutArcs(segments: AuditSegment[], minShare = DONUT_MIN_SHARE): DonutArc[] {
    if (segments.length === 0) {
        return [];
    }
    const shares = donutShares(segments, minShare);
    const total = shares.reduce((sum, value) => sum + value, 0);
    const arcs: DonutArc[] = [];
    let acc = 0;
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const share = total > 0 ? (shares[index] ?? 0) / total : 0;
        if (segment === undefined || share <= 0) continue;
        const start = acc;
        const end = acc + share;
        acc = end;
        const midAngle = ((start + end) / 2) * Math.PI * 2 - Math.PI / 2;
        arcs.push({
            ...segment,
            path: donutArcPath(start, end),
            offset: {
                x: Math.cos(midAngle) * DONUT_LIFT,
                y: Math.sin(midAngle) * DONUT_LIFT,
            },
        });
    }
    return arcs;
}

/** 占比段 → CSS conic-gradient（兼容保留，按 donutShares 归一化 + 保底）。 */
export function conicGradient(segments: AuditSegment[], minShare = DONUT_MIN_SHARE): string {
    if (segments.length === 0) {
        return 'conic-gradient(var(--border) 0% 100%)';
    }
    const shares = donutShares(segments, minShare);
    const total = shares.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
        return 'conic-gradient(var(--border) 0% 100%)';
    }
    let acc = 0;
    const stops: string[] = [];
    for (let index = 0; index < segments.length; index += 1) {
        const share = shares[index] ?? 0;
        if (share <= 0) continue;
        const start = (acc / total) * 100;
        acc += share;
        const end = (acc / total) * 100;
        stops.push(`var(${segments[index]?.colorVar}) ${start.toFixed(3)}% ${end.toFixed(3)}%`);
    }
    return `conic-gradient(${stops.join(', ')})`;
}

// ============================================================
// View building
// ============================================================

function countTasks(snapshot: GoalTreeSnapshot | null): number {
    let count = 0;
    for (const goal of snapshot?.goals ?? []) {
        count += (goal.tasks ?? []).length;
    }
    return count;
}

function collectSnapshotSteps(
    snapshot: GoalTreeSnapshot | null,
    runIndex: number,
    runInput: string,
    taskStart: number,
): ResolvedStep[] {
    if (!snapshot) return [];
    const out: ResolvedStep[] = [];
    let taskIndex = taskStart;
    for (const goal of snapshot.goals ?? []) {
        for (const task of goal.tasks ?? []) {
            taskIndex += 1;
            const steps = (task.steps ?? []).slice().sort((a, b) => a.startedAt - b.startedAt);
            steps.forEach((step, i) => {
                out.push({
                    stepId: step.stepId,
                    taskId: task.taskId,
                    goalId: goal.goalId,
                    runIndex,
                    runInput,
                    taskIndex,
                    taskTitle: task.title,
                    index: i + 1,
                    kind: step.kind,
                    toolName: step.toolName ?? '',
                    status: step.status,
                    startedAt: step.startedAt ?? 0,
                    endedAt: step.endedAt ?? null,
                    durationMs:
                        step.endedAt && step.startedAt ? step.endedAt - step.startedAt : null,
                    usage: step.usage ?? null,
                    text: step.content ?? step.payloadText ?? '',
                    diffContent: step.usage?.runtime?.diffContent ?? '',
                    lineIndex: 0,
                    contextDelta: null,
                    previousContextTotal: null,
                });
            });
        }
    }
    return out;
}

/**
 * 会话流步骤表：按 Conversation 内 run 顺序拼接所有 run/task/step，
 * 并在整条线上计算 context delta（当前步总量 − 上一步总量）。
 */
function collectRows(input: AuditInput): ResolvedStep[] {
    const runs: AuditRunInput[] =
        input.runs && input.runs.length > 0
            ? input.runs
            : [{ rootGoalId: '', input: '', snapshot: input.snapshot ?? null }];
    const out: ResolvedStep[] = [];
    const indexMap = new Map<string, { index: number; title: string }>();
    let taskStart = 0;
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const run = runs[runIndex];
        const snapshot = run.snapshot ?? null;
        const runRows = collectSnapshotSteps(snapshot, runIndex + 1, run.input ?? '', taskStart);
        for (const row of runRows) {
            if (!indexMap.has(row.taskId)) {
                indexMap.set(row.taskId, { index: row.taskIndex, title: row.taskTitle });
            }
        }
        taskStart += countTasks(snapshot);
        out.push(...runRows);
    }
    // 实时步骤（执行中的 run 尚未落快照）追加在会话线末尾
    const known = new Set(out.map((row) => row.stepId));
    const liveCount = new Map<string, number>();
    for (const step of input.liveSteps ?? []) {
        if (known.has(step.stepId)) continue;
        const next = (liveCount.get(step.taskId) ?? 0) + 1;
        liveCount.set(step.taskId, next);
        const meta = indexMap.get(step.taskId);
        out.push({
            stepId: step.stepId,
            taskId: step.taskId,
            goalId: '',
            runIndex: runs.length + 1,
            runInput: '',
            taskIndex: meta?.index ?? 0,
            taskTitle: meta?.title ?? '',
            index: next,
            kind: step.kind,
            toolName: step.toolName,
            status: step.status,
            startedAt: step.startedAt,
            endedAt: step.endedAt,
            durationMs: step.endedAt ? step.endedAt - step.startedAt : null,
            usage: step.usage ?? null,
            text: step.content,
            diffContent: step.usage?.runtime?.diffContent ?? '',
            lineIndex: 0,
            contextDelta: null,
            previousContextTotal: null,
        });
    }
    // 整条会话线的全局序号与 context delta
    let lineIndex = 0;
    let prevTotal: number | null = null;
    for (const row of out) {
        lineIndex += 1;
        row.lineIndex = lineIndex;
        const total = row.usage?.runtime?.totalContextTokens ?? null;
        row.contextDelta = total !== null && prevTotal !== null ? total - prevTotal : null;
        row.previousContextTotal = prevTotal;
        if (total !== null) prevTotal = total;
    }
    return out;
}

function toRow(step: ResolvedStep, selectedId: string): AuditStepRow {
    const runtime = step.usage?.runtime;
    const tokens = (step.usage?.vendor?.inputTokens ?? 0) + (step.usage?.vendor?.outputTokens ?? 0);
    return {
        stepId: step.stepId,
        lineIndex: step.lineIndex,
        runIndex: step.runIndex,
        index: step.index,
        kind: step.kind,
        toolName: step.toolName,
        status: step.status,
        durationMs: step.durationMs,
        tokens,
        contextTotal: runtime?.totalContextTokens ?? null,
        contextDelta: step.contextDelta,
        diffContent: step.diffContent,
        selected: step.stepId === selectedId,
    };
}

function driftOf(cost: CostAggregate | null, estimated: CostAggregate | null): CostDrift | null {
    if (!cost || !estimated || cost.total <= 0) return null;
    const usd = estimated.total - cost.total;
    return { usd, rate: usd / cost.total };
}

function extrasOf(
    usage: AggregatedUsage,
): Pick<AuditView, 'costDrift' | 'estimatedTotal' | 'vendorTotal'> {
    return {
        costDrift: driftOf(usage.cost, usage.estimatedCost),
        estimatedTotal: usage.estimate
            ? usage.estimate.inputTotal + usage.estimate.outputTotal
            : null,
        vendorTotal: usage.vendor ? usage.vendor.total : null,
    };
}

const EMPTY_USAGE: AggregatedUsage = {
    vendor: null,
    runtime: null,
    estimate: null,
    cost: null,
    estimatedCost: null,
    timing: null,
};

function noneView(stale: boolean): AuditView {
    return {
        kind: 'none',
        stale,
        title: stale ? '目标已失效' : '未选择',
        subtitle: stale ? '请重新选择 Step 或 Task' : '点击对话流中的 Step 或 Task 查看审计',
        usage: EMPTY_USAGE,
        segments: [],
        utilization: null,
        diff: null,
        strategies: [],
        budgetPressureAction: '',
        rows: [],
        diffContent: '',
        costDrift: null,
        estimatedTotal: null,
        vendorTotal: null,
    };
}

/** 目标解析：step 优先于 task；两者都无 → 会话汇总。 */
export function buildAuditView(input: AuditInput): AuditView {
    const rows = collectRows(input);
    const stepId = input.stepId ?? '';
    const taskId = input.taskId ?? '';
    const selected = stepId ? rows.find((row) => row.stepId === stepId) : undefined;
    const taskRows = taskId ? rows.filter((row) => row.taskId === taskId) : [];
    const snapshots =
        input.runs && input.runs.length > 0
            ? input.runs.map((run) => run.snapshot)
            : [input.snapshot ?? null];
    const taskExists = snapshots.some((snapshot) =>
        (snapshot?.goals ?? []).some((goal) =>
            (goal.tasks ?? []).some((task) => task.taskId === taskId),
        ),
    );

    if (stepId && !selected) {
        return noneView(true);
    }
    if (taskId && taskRows.length === 0 && !taskExists) {
        return noneView(true);
    }

    if (selected) {
        const usage = aggregateUsage([selected]);
        const runtime = usage.runtime;
        const total = runtime?.totalContextTokens ?? null;
        const delta = selected.contextDelta;
        const from =
            total !== null && delta !== null
                ? (selected.previousContextTotal ?? total - delta)
                : null;
        const toolSuffix = selected.toolName ? ` ${selected.toolName}` : '';
        const statusSuffix = selected.status ? ` · ${selected.status}` : '';
        return {
            kind: 'step',
            stale: false,
            title: `S#${selected.index} · ${kindLabel(selected.kind)}${toolSuffix}`,
            subtitle: formatDuration(selected.durationMs) + statusSuffix,
            usage,
            segments: contextSegments(runtime),
            utilization: runtime?.contextWindowUtilization ?? null,
            diff:
                total !== null && delta !== null && from !== null
                    ? { delta, from, to: total }
                    : null,
            strategies: runtime?.strategyApplied ?? [],
            budgetPressureAction: runtime?.budgetPressureAction ?? '',
            rows: [],
            diffContent: runtime?.diffContent ?? '',
            ...extrasOf(usage),
        };
    }

    if (taskId) {
        const usage = aggregateUsage(taskRows);
        const runtime = usage.runtime;
        const title = taskRows[0]?.taskTitle || 'Task';
        const index = taskRows[0]?.taskIndex ?? 0;
        return {
            kind: 'task',
            stale: false,
            title: `T#${index} · ${title}`,
            subtitle: `${taskRows.length} steps`,
            usage,
            segments: contextSegments(runtime),
            utilization: runtime?.contextWindowUtilization ?? null,
            diff: null,
            strategies: runtime?.strategyApplied ?? [],
            budgetPressureAction: runtime?.budgetPressureAction ?? '',
            rows: taskRows.map((row) => toRow(row, stepId)),
            diffContent: '',
            ...extrasOf(usage),
        };
    }

    const usage = aggregateUsage(rows);
    const runtime = usage.runtime;
    const runCount = input.runs && input.runs.length > 0 ? input.runs.length : 1;
    return {
        kind: 'conversation',
        stale: false,
        title: '会话汇总',
        subtitle: (input.conversationTitle ?? '').trim() || `${runCount} 轮 · ${rows.length} 步`,
        usage,
        segments: contextSegments(runtime),
        utilization: runtime?.contextWindowUtilization ?? null,
        diff: null,
        strategies: runtime?.strategyApplied ?? [],
        budgetPressureAction: runtime?.budgetPressureAction ?? '',
        rows: rows.map((row) => toRow(row, stepId)),
        diffContent: '',
        ...extrasOf(usage),
    };
}

/** 空视图（未选择目标）。 */
export function emptyAuditView(): AuditView {
    return noneView(false);
}

// ============================================================
// Formatting
// ============================================================

export function kindLabel(kind: string): string {
    if (kind === 'tool_call') return 'tool';
    return kind || '-';
}

export function formatTokens(value: number | null | undefined): string {
    const n = value ?? 0;
    if (n < 1000) return String(n);
    if (n < 1000000) return `${trimZero(n / 1000)}K`;
    return `${trimZero(n / 1000000)}M`;
}

function trimZero(value: number): string {
    const fixed = value.toFixed(1);
    return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

export function formatCost(usd: number | null | undefined): string {
    const n = Number(usd ?? 0);
    if (!Number.isFinite(n) || n === 0) return '$0';
    return `$${n.toFixed(6)}`;
}

export function formatPercent(ratio: number | null | undefined): string {
    return `${((ratio ?? 0) * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** 有符号整数展示（漂移 token 数）。 */
export function formatSigned(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '-';
    return (value > 0 ? '+' : '') + String(Math.round(value));
}

/** 有符号比率展示（漂移率）。 */
export function formatRate(rate: number | null | undefined): string {
    if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
    return `${(rate > 0 ? '+' : '') + (rate * 100).toFixed(1)}%`;
}
