/**
 * audit —— 观测看板的纯计算层（docs/web/观测看板设计.md v2）。
 * 只做「快照/实时步骤 → 面板视图」投影：vendor / 输入估算 / 输出估算 / 成本双口径聚合、
 * 输入分段占比、逐步骤 context diff。无副作用，不依赖 Vue，便于单测。
 */

import type {
    GoalTreeSnapshot,
    StepContextContents,
    StepOutputContents,
    StepPricingUsage,
    StepRuntimeUsage,
    StepUsage,
} from '../types.ts';

/** 单段 diff（Context 追踪用）。 */
export interface AuditDiffPart {
    key: string;
    label: string;
    text: string;
}

/**
 * Context 分段的两个轴（三段工具相关段落互不重叠）：
 *  - 请求固定开销：systemPrompt、toolSchema（每轮原样重发，不随历史增长）
 *  - 消息历史：historyUser、historyAssistant、toolCalls（assistant 的 tool_call 参数）、
 *    observation（role=tool 的工具结果）、newInput（本轮用户输入）
 * 其中 toolSchema = 工具定义、toolCalls = 模型产生的调用参数、observation = 工具返回结果。
 * retrieved / examples 为保留段，当前无生产者，恒为 0。
 */
// 按 role 分组展示；contextDiffParts 会过滤空段（diff=0 不展示）。
const DIFF_SEGMENT_LABELS: Array<{ key: keyof StepContextContents; label: string }> = [
    { key: 'systemPrompt', label: 'system' },
    { key: 'historyUser', label: 'user history' },
    { key: 'historyAssistant', label: 'assistant' },
    { key: 'toolCalls', label: 'assistant tool-call args' },
    { key: 'toolSchema', label: 'tools (schema)' },
    { key: 'newInput', label: 'user input' },
    // observation = 回灌进模型上下文的工具结果（tool result messages）。
    { key: 'observation', label: 'tool results' },
    { key: 'retrieved', label: 'retrieved' },
    { key: 'examples', label: 'examples' },
];

/** 每步各段新增内容 → 有序的非空 diff 列表。 */
export function contextDiffParts(
    diffContents: StepContextContents | null | undefined,
): AuditDiffPart[] {
    if (!diffContents) return [];
    return DIFF_SEGMENT_LABELS.map(({ key, label }) => ({
        key,
        label,
        text: String(diffContents[key] ?? ''),
    })).filter((part) => part.text.trim().length > 0);
}

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

/** 输出分段聚合（reasoning / tool-call args / text）。 */
export interface OutputAggregate {
    reasoningTokens: number;
    toolCallArgsTokens: number;
    textTokens: number;
    totalOutputTokens: number;
    contents: StepOutputContents | null;
}

/** vendor 成本分解（按 vendor token + 入库计价快照重算）。 */
export interface AuditVendorCost {
    pricing: StepPricingUsage;
    inputMissedTokens: number;
    inputCachedTokens: number;
    reasoningTokens: number;
    textTokens: number;
    toolCallArgsTokens: number;
    inputMissedUsd: number;
    inputCachedUsd: number;
    reasoningUsd: number;
    textUsd: number;
    toolCallArgsUsd: number;
    totalUsd: number;
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
    /** 输出分段聚合（reasoning / tool-call args / text） */
    output: OutputAggregate | null;
    /** 最新一轮的计价快照 */
    pricing: StepPricingUsage | null;
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
    /** 所属 task 序号（1-based，每个 run/Session 内重新从 1 起） */
    taskIndex: number;
    /** task 内步骤序号（1-based） */
    index: number;
    kind: string;
    toolName: string;
    /** 工具行命令/参数摘要（Context 面板折叠展示用） */
    toolCommand: string;
    /** 工作目录（缩短 home） */
    toolCwd: string;
    /** 完整工具行：`<cwd> <工具/命令+参数>`（如 `~/.mazi ls .`） */
    toolLine: string;
    status: string;
    durationMs: number | null;
    tokens: number;
    contextTotal: number | null;
    contextDelta: number | null;
    /** 相对上一步新增的上下文内容（截断；合并文本） */
    diffContent: string;
    /** 相对上一步各段新增内容（Context 追踪按段展开） */
    diffParts: AuditDiffPart[];
    /** 该步的 context 分段（Context 追踪堆叠条） */
    segments: AuditSegment[];
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

/** 工具调用专用审计视图（tool_call step）：命令 / 参数 / 输出 / 耗时。 */
export interface AuditToolView {
    name: string;
    /** 展示用命令（shell.run 取 command；其余取单值或 JSON） */
    command: string;
    /** 工作目录（缩短 home） */
    cwd: string;
    /** 完整展示行：`<cwd> <命令/工具+参数>`，如 `~/.mazi ls .` */
    line: string;
    arguments: Record<string, unknown> | null;
    output: string;
    durationMs: number | null;
    status: string;
    isError: boolean;
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
    /** 输出分段（reasoning / tool-call args / text） */
    output: OutputAggregate | null;
    /** vendor 成本分解（按入库计价快照重算） */
    vendorCost: AuditVendorCost | null;
    /** 最新一轮计价快照 */
    pricing: StepPricingUsage | null;
    /** 与上一轮相比的新增内容，按 role 分段（空段已过滤） */
    diffParts: AuditDiffPart[];
    /** tool_call step 的专用视图；非工具步为 null */
    tool: AuditToolView | null;
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
    /** tool_call：命令参数（展示/审计用） */
    toolArguments: Record<string, unknown> | null;
    /** tool_call：工具实际执行的工作目录 */
    toolCwd: string | null;
    /** tool_call：完整输出 */
    toolOutput: string | null;
    /** 相对上一轮新增的上下文内容（截断，合并） */
    diffContent: string;
    /** 相对上一轮各段新增内容（截断） */
    diffContents: StepContextContents | null;
    /** 会话流中的全局序号（collectRows 结束后赋值） */
    lineIndex: number;
    /** 会话流中相对上一步的上下文 delta / 上一步总量（collectRows 结束后赋值） */
    contextDelta: number | null;
    previousContextTotal: number | null;
    /** 被折叠进来的 stepId（如 intent 并入 thinking）：点击这些 stepId 仍可定位到本行 */
    aliasStepIds?: string[];
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
    let output: OutputAggregate | null = null;
    let pricing: StepPricingUsage | null = null;
    let pricingAt = Number.NEGATIVE_INFINITY;
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
    // 一轮模型调用的 usage 可能挂在同一 roundId 的 thinking + intent 两个 step 上；只计一次。
    const seenRounds = new Set<string>();
    for (const step of steps) {
        const usage = step.usage;
        if (!usage) continue;
        if (usage.roundId !== undefined) {
            if (seenRounds.has(usage.roundId)) continue;
            seenRounds.add(usage.roundId);
        }
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
        if (usage.output) {
            output ??= {
                reasoningTokens: 0,
                toolCallArgsTokens: 0,
                textTokens: 0,
                totalOutputTokens: 0,
                contents: null,
            };
            output.reasoningTokens += usage.output.reasoningTokens ?? 0;
            output.toolCallArgsTokens += usage.output.toolCallArgsTokens ?? 0;
            output.textTokens += usage.output.textTokens ?? 0;
            output.totalOutputTokens += usage.output.totalOutputTokens ?? 0;
            if (output.contents === null && usage.output.contents) {
                output.contents = usage.output.contents;
            }
        }
        if (usage.pricing && step.startedAt >= pricingAt) {
            pricing = usage.pricing;
            pricingAt = step.startedAt;
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
    return { vendor, runtime, estimate, output, pricing, cost, estimatedCost, timing };
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
        // observation 段 = 上下文里回灌的工具结果（message.role === 'tool'）。
        key: 'observation',
        label: 'tool results',
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

function _countTasks(snapshot: GoalTreeSnapshot | null): number {
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
            const taskRows: ResolvedStep[] = [];
            steps.forEach((step, i) => {
                taskRows.push({
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
                    toolArguments: step.toolArguments ?? null,
                    toolCwd: step.toolCwd ?? null,
                    toolOutput: step.toolOutput ?? null,
                    status: step.status,
                    startedAt: step.startedAt ?? 0,
                    endedAt: step.endedAt ?? null,
                    durationMs:
                        step.endedAt && step.startedAt ? step.endedAt - step.startedAt : null,
                    usage: step.usage ?? null,
                    text: step.content ?? step.payloadText ?? '',
                    diffContent: step.usage?.runtime?.diffContent ?? '',
                    diffContents: step.usage?.runtime?.diffContents ?? null,
                    lineIndex: 0,
                    contextDelta: null,
                    previousContextTotal: null,
                });
            });
            out.push(...taskRows);
        }
    }
    return out;
}

/**
 * thinking 与 intent 属同一轮模型调用（同一 step 的推理 + 输出）：折叠为一行，
 * 以 thinking 代表该轮（S# 因此不跳号）。若某轮只有 intent（无推理），把它改标为
 * thinking 保留可见。
 */
function collapseModelRows(rows: ResolvedStep[]): ResolvedStep[] {
    const out: ResolvedStep[] = [];
    for (const row of rows) {
        if (row.kind === 'intent') {
            const prev = out[out.length - 1];
            if (prev && prev.kind === 'thinking' && prev.taskId === row.taskId) {
                if (prev.text.length === 0) prev.text = row.text;
                if (row.endedAt !== null) prev.endedAt = row.endedAt;
                // Keep the absorbed intent selectable (bottom Summary links to it).
                if (!prev.aliasStepIds) prev.aliasStepIds = [];
                prev.aliasStepIds.push(row.stepId);
                continue;
            }
            out.push({ ...row, kind: 'thinking' });
            continue;
        }
        out.push(row);
    }
    return out;
}

/**
 * 会话流步骤表：按 Conversation 内 run 顺序拼接所有 run/task/step，
 * 并在整条线上计算 context delta（当前步总量 − 上一步总量）。
 *
 * 编号语义：R# = run（Session）；T# = 该 run 内的 task（每个 run 从 1 起）；
 * S# = 该 task 内的 step（折叠 thinking/intent 后从 1 起）。
 */
function collectRows(input: AuditInput): ResolvedStep[] {
    const runs: AuditRunInput[] =
        input.runs && input.runs.length > 0
            ? input.runs
            : [{ rootGoalId: '', input: '', snapshot: input.snapshot ?? null }];
    const out: ResolvedStep[] = [];
    const indexMap = new Map<string, { index: number; title: string }>();
    for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
        const run = runs[runIndex];
        const snapshot = run.snapshot ?? null;
        // T# restarts at 1 for every run (Session), not accumulated across runs.
        const runRows = collectSnapshotSteps(snapshot, runIndex + 1, run.input ?? '', 0);
        for (const row of runRows) {
            if (!indexMap.has(row.taskId)) {
                indexMap.set(row.taskId, { index: row.taskIndex, title: row.taskTitle });
            }
        }
        out.push(...runRows);
    }
    // 实时步骤（执行中的 run 尚未落快照）追加在会话线末尾
    const known = new Set(out.map((row) => row.stepId));
    const liveCount = new Map<string, number>();
    let nextLiveTaskIndex = 0;
    for (const step of input.liveSteps ?? []) {
        if (known.has(step.stepId)) continue;
        const next = (liveCount.get(step.taskId) ?? 0) + 1;
        liveCount.set(step.taskId, next);
        const meta = indexMap.get(step.taskId);
        // Unknown (brand-new) task in the live run: number it within that run.
        if (!meta) nextLiveTaskIndex += 1;
        out.push({
            stepId: step.stepId,
            taskId: step.taskId,
            goalId: '',
            runIndex: runs.length + 1,
            runInput: '',
            taskIndex: meta?.index ?? nextLiveTaskIndex,
            taskTitle: meta?.title ?? '',
            index: next,
            kind: step.kind,
            toolName: step.toolName,
            toolArguments: null,
            toolCwd: null,
            toolOutput: step.kind === 'tool_call' ? step.content || null : null,
            status: step.status,
            startedAt: step.startedAt,
            endedAt: step.endedAt,
            durationMs: step.endedAt ? step.endedAt - step.startedAt : null,
            usage: step.usage ?? null,
            text: step.content,
            diffContent: step.usage?.runtime?.diffContent ?? '',
            diffContents: step.usage?.runtime?.diffContents ?? null,
            lineIndex: 0,
            contextDelta: null,
            previousContextTotal: null,
        });
    }
    // 折叠 thinking/intent，并重排每 task 的 S#（会话线全局序号 + context delta）
    const collapsed = collapseModelRows(out);
    const stepCount = new Map<string, number>();
    let lineIndex = 0;
    let prevTotal: number | null = null;
    for (const row of collapsed) {
        const nextIndex = (stepCount.get(row.taskId) ?? 0) + 1;
        stepCount.set(row.taskId, nextIndex);
        row.index = nextIndex;
        lineIndex += 1;
        row.lineIndex = lineIndex;
        const total = row.usage?.runtime?.totalContextTokens ?? null;
        row.contextDelta = total !== null && prevTotal !== null ? total - prevTotal : null;
        row.previousContextTotal = prevTotal;
        if (total !== null) prevTotal = total;
    }
    return collapsed;
}

function toRow(step: ResolvedStep, selectedId: string): AuditStepRow {
    const runtime = step.usage?.runtime;
    const tokens = (step.usage?.vendor?.inputTokens ?? 0) + (step.usage?.vendor?.outputTokens ?? 0);
    return {
        stepId: step.stepId,
        lineIndex: step.lineIndex,
        runIndex: step.runIndex,
        taskIndex: step.taskIndex,
        index: step.index,
        kind: step.kind,
        toolName: step.toolName,
        toolCommand: formatToolCommand(step.toolName, step.toolArguments),
        toolCwd: shortenHome(step.toolCwd),
        toolLine: toolLineOf(step.toolName, step.toolCwd, step.toolArguments),
        status: step.status,
        durationMs: step.durationMs,
        tokens,
        contextTotal: runtime?.totalContextTokens ?? null,
        contextDelta: step.contextDelta,
        diffContent: step.diffContent,
        diffParts: contextDiffParts(step.diffContents),
        segments: contextSegments(runtime),
        selected: step.stepId === selectedId || step.aliasStepIds?.includes(selectedId) === true,
    };
}

function driftOf(cost: CostAggregate | null, estimated: CostAggregate | null): CostDrift | null {
    if (!cost || !estimated || cost.total <= 0) return null;
    const usd = estimated.total - cost.total;
    return { usd, rate: usd / cost.total };
}

/** vendor 成本分解：vendor token 用量 × 入库计价快照（输出按分段比例拆分）。 */
export function vendorCostOf(usage: AggregatedUsage): AuditVendorCost | null {
    const vendor = usage.vendor;
    const pricing = usage.pricing;
    if (!vendor || !pricing) return null;
    const inputCachedTokens = vendor.cacheRead ?? 0;
    const inputMissedTokens = Math.max(
        0,
        vendor.input - inputCachedTokens - (vendor.cacheCreation ?? 0),
    );
    const reasoningTokens = vendor.reasoning ?? 0;
    const nonReasoning = Math.max(0, vendor.output - reasoningTokens);
    const estText = usage.output?.textTokens ?? 0;
    const estArgs = usage.output?.toolCallArgsTokens ?? 0;
    const estTotal = estText + estArgs;
    const textTokens =
        estTotal > 0 ? Math.round(nonReasoning * (estText / estTotal)) : nonReasoning;
    const toolCallArgsTokens = Math.max(0, nonReasoning - textTokens);
    const reasoningRate = pricing.reasoningPerMTok ?? pricing.outputPerMTok;
    const usd = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
    const inputMissedUsd = usd(inputMissedTokens, pricing.inputPerMTok);
    const inputCachedUsd = usd(inputCachedTokens, pricing.cachedInputPerMTok);
    const reasoningUsd = usd(reasoningTokens, reasoningRate);
    const textUsd = usd(textTokens, pricing.outputPerMTok);
    const toolCallArgsUsd = usd(toolCallArgsTokens, pricing.outputPerMTok);
    return {
        pricing,
        inputMissedTokens,
        inputCachedTokens,
        reasoningTokens,
        textTokens,
        toolCallArgsTokens,
        inputMissedUsd,
        inputCachedUsd,
        reasoningUsd,
        textUsd,
        toolCallArgsUsd,
        totalUsd: inputMissedUsd + inputCachedUsd + reasoningUsd + textUsd + toolCallArgsUsd,
    };
}

function extrasOf(
    usage: AggregatedUsage,
): Pick<
    AuditView,
    'costDrift' | 'estimatedTotal' | 'vendorTotal' | 'output' | 'vendorCost' | 'pricing'
> {
    return {
        costDrift: driftOf(usage.cost, usage.estimatedCost),
        estimatedTotal: usage.estimate
            ? usage.estimate.inputTotal + usage.estimate.outputTotal
            : null,
        vendorTotal: usage.vendor ? usage.vendor.total : null,
        output: usage.output,
        vendorCost: vendorCostOf(usage),
        pricing: usage.pricing,
    };
}

/** 工具调用参数 → 展示用命令（shell.run 取 command；单值取该值；否则 JSON）。 */
function formatToolCommand(toolName: string, args: Record<string, unknown> | null): string {
    if (args === null) return '';
    const entries = Object.entries(args);
    if (entries.length === 0) return '';
    if (toolName === 'shell.run' && typeof args.command === 'string') return args.command;
    const single = entries[0]?.[1];
    if (entries.length === 1 && typeof single === 'string') return single;
    return JSON.stringify(args);
}

/** /Users/<user>/x → ~/x，/home/<user>/x → ~/x。 */
function shortenHome(path: string | null | undefined): string {
    if (!path) return '';
    return path.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** 完整工具行：`<cwd> <命令/工具+参数>`，如 `~/.mazi ls .`。 */
function toolLineOf(
    toolName: string,
    cwd: string | null,
    args: Record<string, unknown> | null,
): string {
    const command = formatToolCommand(toolName, args);
    const display =
        toolName === 'shell.run'
            ? command
            : [toolName, command].filter((part) => part.length > 0).join(' ');
    return [shortenHome(cwd), display].filter((part) => part.length > 0).join(' ');
}

function toolViewOf(step: ResolvedStep): AuditToolView {
    return {
        name: step.toolName || step.kind,
        command: formatToolCommand(step.toolName, step.toolArguments),
        cwd: shortenHome(step.toolCwd),
        line: toolLineOf(step.toolName, step.toolCwd, step.toolArguments),
        arguments: step.toolArguments,
        output: step.toolOutput ?? step.text ?? '',
        durationMs: step.durationMs,
        status: step.status,
        isError: step.status === 'error' || step.status === 'failed',
    };
}

const EMPTY_USAGE: AggregatedUsage = {
    vendor: null,
    runtime: null,
    estimate: null,
    output: null,
    pricing: null,
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
        diffParts: [],
        costDrift: null,
        estimatedTotal: null,
        vendorTotal: null,
        output: null,
        vendorCost: null,
        pricing: null,
        tool: null,
    };
}

/** 目标解析：step 优先于 task；两者都无 → 会话汇总。 */
export function buildAuditView(input: AuditInput): AuditView {
    const rows = collectRows(input);
    const stepId = input.stepId ?? '';
    const taskId = input.taskId ?? '';
    const selected = stepId
        ? rows.find((row) => row.stepId === stepId || row.aliasStepIds?.includes(stepId))
        : undefined;
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
            title: `R#${selected.runIndex}·T#${selected.taskIndex}·S#${selected.index} · ${kindLabel(selected.kind)}${toolSuffix}`,
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
            diffParts: contextDiffParts(selected.diffContents),
            ...extrasOf(usage),
            tool: selected.kind === 'tool_call' ? toolViewOf(selected) : null,
        };
    }

    if (taskId) {
        const usage = aggregateUsage(taskRows);
        const runtime = usage.runtime;
        const title = taskRows[0]?.taskTitle || 'Task';
        const index = taskRows[0]?.taskIndex ?? 0;
        const runIndex = taskRows[0]?.runIndex ?? 1;
        return {
            kind: 'task',
            stale: false,
            title: `R#${runIndex}·T#${index} · ${title}`,
            subtitle: `${taskRows.length} steps · ${formatDuration(usage.timing?.totalMs ?? null)}`,
            usage,
            segments: contextSegments(runtime),
            utilization: runtime?.contextWindowUtilization ?? null,
            diff: null,
            strategies: runtime?.strategyApplied ?? [],
            budgetPressureAction: runtime?.budgetPressureAction ?? '',
            rows: taskRows.map((row) => toRow(row, stepId)),
            diffContent: '',
            diffParts: contextDiffParts(runtime?.diffContents),
            ...extrasOf(usage),
            tool: null,
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
        diffParts: contextDiffParts(runtime?.diffContents),
        ...extrasOf(usage),
        tool: null,
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

/** token 数：保留两位小数（1.85K / 2.34M），<1000 显示整数。 */
export function formatTokens(value: number | null | undefined): string {
    const n = value ?? 0;
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(2)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * 金额：最多 6 位小数（去掉末尾多余的 0），单位统一为人民币「¥」。
 * 计价口径为元（pricing 快照入库时即元）。
 */
export function formatCost(value: number | null | undefined): string {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n) || n === 0) return '¥0';
    const fixed = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return `¥${fixed}`;
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
