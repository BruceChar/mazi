/**
 * usage-view —— Step.usage（core Usage，unknown）→ 线协议 StepUsage 投影。
 * 供 emitStep（SSE 实时载荷）与 goal-snapshot（timeline 快照）共用，保证两路一致；
 * 缺省字段不输出，前端按可选处理（docs/web/观测看板设计.md §2）。
 */

import type { StepUsage } from '@mazi/libs';

function numberOf(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOf(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function stringArrayOf(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
        ? (value as string[])
        : undefined;
}

function stringOf(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

type StepContents = NonNullable<NonNullable<StepUsage['runtime']>['contents']>;

const CONTENT_KEYS = [
    'systemPrompt',
    'historyUser',
    'historyAssistant',
    'toolCalls',
    'toolSchema',
    'newInput',
    'observation',
    'retrieved',
    'examples',
] as const;

function contentsView(source: Record<string, unknown>): StepContents | undefined {
    const view = {} as StepContents;
    let any = false;
    for (const key of CONTENT_KEYS) {
        const value = source[key];
        if (typeof value === 'string') {
            view[key] = value;
            any = true;
        }
    }
    return any ? view : undefined;
}

function vendorView(source: Record<string, unknown>): StepUsage['vendor'] | undefined {
    const inputTokens = numberOf(source.inputTokens);
    const outputTokens = numberOf(source.outputTokens);
    if (inputTokens === undefined && outputTokens === undefined) {
        return undefined;
    }
    const view: NonNullable<StepUsage['vendor']> = {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
    };
    const cacheCreation = numberOf(source.cacheCreationInputTokens);
    if (cacheCreation !== undefined) view.cacheCreationInputTokens = cacheCreation;
    const cacheRead = numberOf(source.cacheReadInputTokens);
    if (cacheRead !== undefined) view.cacheReadInputTokens = cacheRead;
    const reasoning = numberOf(source.reasoningOutputTokens);
    if (reasoning !== undefined) view.reasoningOutputTokens = reasoning;
    const reported = booleanOf(source.reportedByVendor);
    if (reported !== undefined) view.reportedByVendor = reported;
    return view;
}

function runtimeView(source: Record<string, unknown>): StepUsage['runtime'] | undefined {
    const totalContextTokens = numberOf(source.totalContextTokens);
    if (totalContextTokens === undefined) {
        return undefined;
    }
    const view: NonNullable<StepUsage['runtime']> = {
        totalContextTokens,
        systemPromptTokens: numberOf(source.systemPromptTokens) ?? 0,
        historyTokens: numberOf(source.historyTokens) ?? 0,
        toolSchemaTokens: numberOf(source.toolSchemaTokens) ?? 0,
        newInputTokens: numberOf(source.newInputTokens) ?? 0,
        observationTokens: numberOf(source.observationTokens) ?? 0,
    };
    const historyUser = numberOf(source.historyUserTokens);
    if (historyUser !== undefined) view.historyUserTokens = historyUser;
    const historyAssistant = numberOf(source.historyAssistantTokens);
    if (historyAssistant !== undefined) view.historyAssistantTokens = historyAssistant;
    const toolCall = numberOf(source.toolCallTokens);
    if (toolCall !== undefined) view.toolCallTokens = toolCall;
    const retrieved = numberOf(source.retrievedTokens);
    if (retrieved !== undefined) view.retrievedTokens = retrieved;
    const examples = numberOf(source.exampleTokens);
    if (examples !== undefined) view.exampleTokens = examples;
    const systemPromptRatio = numberOf(source.systemPromptRatio);
    if (systemPromptRatio !== undefined) view.systemPromptRatio = systemPromptRatio;
    const utilization = numberOf(source.contextWindowUtilization);
    if (utilization !== undefined) view.contextWindowUtilization = utilization;
    const delta = numberOf(source.contextDeltaFromPrev);
    if (delta !== undefined) view.contextDeltaFromPrev = delta;
    const strategies = stringArrayOf(source.strategyApplied);
    if (strategies !== undefined) view.strategyApplied = strategies;
    const pressure = stringOf(source.budgetPressureAction);
    if (pressure !== undefined) view.budgetPressureAction = pressure;
    const drift = numberOf(source.estimationDriftTokens);
    if (drift !== undefined) view.estimationDriftTokens = drift;
    const driftRate = numberOf(source.estimationDriftRate);
    if (driftRate !== undefined) view.estimationDriftRate = driftRate;
    const contents = subRecord(source.contents);
    if (contents !== undefined) {
        const mapped = contentsView(contents);
        if (mapped !== undefined) view.contents = mapped;
    }
    const diffContent = stringOf(source.diffContent);
    if (diffContent !== undefined) view.diffContent = diffContent;
    const diffContents = subRecord(source.diffContents);
    if (diffContents !== undefined) {
        const mapped = contentsView(diffContents);
        if (mapped !== undefined) view.diffContents = mapped;
    }
    return view;
}

function estimateView(source: Record<string, unknown>): StepUsage['estimate'] | undefined {
    const outputTokens = numberOf(source.outputTokens);
    if (outputTokens === undefined) {
        return undefined;
    }
    const view: NonNullable<StepUsage['estimate']> = { outputTokens };
    const drift = numberOf(source.outputDriftTokens);
    if (drift !== undefined) view.outputDriftTokens = drift;
    const rate = numberOf(source.outputDriftRate);
    if (rate !== undefined) view.outputDriftRate = rate;
    return view;
}

function costView(source: Record<string, unknown>): StepUsage['cost'] | undefined {
    const total = numberOf(source.totalCostUsd);
    if (total === undefined) {
        return undefined;
    }
    const view: NonNullable<StepUsage['cost']> = {
        inputCostUsd: numberOf(source.inputCostUsd) ?? 0,
        outputCostUsd: numberOf(source.outputCostUsd) ?? 0,
        cacheWriteCostUsd: numberOf(source.cacheWriteCostUsd) ?? 0,
        cacheReadCostUsd: numberOf(source.cacheReadCostUsd) ?? 0,
        reasoningCostUsd: numberOf(source.reasoningCostUsd) ?? 0,
        totalCostUsd: total,
        currency: 'USD',
    };
    const tier = stringOf(source.priceTierApplied);
    if (tier !== undefined) view.priceTierApplied = tier;
    const version = stringOf(source.pricingVersion);
    if (version !== undefined) view.pricingVersion = version;
    return view;
}

function timingView(source: Record<string, unknown>): StepUsage['timing'] | undefined {
    const totalMs = numberOf(source.totalMs);
    if (totalMs === undefined) {
        return undefined;
    }
    return {
        ttftMs: numberOf(source.ttftMs) ?? 0,
        totalMs,
        tokensPerSecond: numberOf(source.tokensPerSecond) ?? 0,
    };
}

function rawView(source: Record<string, unknown>): NonNullable<StepUsage['raw']> {
    const view: NonNullable<StepUsage['raw']> = {};
    const providerId = stringOf(source.providerId);
    if (providerId !== undefined) view.providerId = providerId;
    const modelId = stringOf(source.modelId);
    if (modelId !== undefined) view.modelId = modelId;
    const inputTokens = numberOf(source.inputTokens);
    if (inputTokens !== undefined) view.inputTokens = inputTokens;
    const outputTokens = numberOf(source.outputTokens);
    if (outputTokens !== undefined) view.outputTokens = outputTokens;
    const cachedInputTokens = numberOf(source.cachedInputTokens);
    if (cachedInputTokens !== undefined) view.cachedInputTokens = cachedInputTokens;
    const cachedWriteInputTokens = numberOf(source.cachedWriteInputTokens);
    if (cachedWriteInputTokens !== undefined) {
        view.cachedWriteInputTokens = cachedWriteInputTokens;
    }
    const reasoningTokens = numberOf(source.reasoningTokens);
    if (reasoningTokens !== undefined) view.reasoningTokens = reasoningTokens;
    const totalTokens = numberOf(source.totalTokens);
    if (totalTokens !== undefined) view.totalTokens = totalTokens;
    const ttftMs = numberOf(source.ttftMs);
    if (ttftMs !== undefined) view.ttftMs = ttftMs;
    const totalMs = numberOf(source.totalMs);
    if (totalMs !== undefined) view.totalMs = totalMs;
    return view;
}

function pinView(source: Record<string, unknown>): NonNullable<StepUsage['pin']> {
    const view: NonNullable<StepUsage['pin']> = {};
    const offeringId = stringOf(source.offeringId);
    if (offeringId !== undefined) view.offeringId = offeringId;
    const pricingPlanId = stringOf(source.pricingPlanId);
    if (pricingPlanId !== undefined) view.pricingPlanId = pricingPlanId;
    const catalogEpoch = numberOf(source.catalogEpoch);
    if (catalogEpoch !== undefined) view.catalogEpoch = catalogEpoch;
    return view;
}

/** 由原始事实派生 vendor 视图（读取时重算，而非依赖写入时算出的展示值）。 */
function vendorFromRaw(raw: NonNullable<StepUsage['raw']>): StepUsage['vendor'] | undefined {
    const inputTokens = raw.inputTokens;
    const outputTokens = raw.outputTokens;
    if (inputTokens === undefined && outputTokens === undefined) return undefined;
    const view: NonNullable<StepUsage['vendor']> = {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        totalTokens: raw.totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    };
    if (raw.cachedWriteInputTokens !== undefined) {
        view.cacheCreationInputTokens = raw.cachedWriteInputTokens;
    }
    if (raw.cachedInputTokens !== undefined) view.cacheReadInputTokens = raw.cachedInputTokens;
    if (raw.reasoningTokens !== undefined) view.reasoningOutputTokens = raw.reasoningTokens;
    return view;
}

/** 由原始事实派生 timing 视图。 */
function timingFromRaw(raw: NonNullable<StepUsage['raw']>): StepUsage['timing'] | undefined {
    if (raw.totalMs === undefined) return undefined;
    const ttftMs = raw.ttftMs ?? 0;
    const outputTokens = raw.outputTokens ?? 0;
    const generationMs = raw.totalMs - ttftMs;
    return {
        ttftMs,
        totalMs: raw.totalMs,
        tokensPerSecond:
            outputTokens > 0 && generationMs > 0 ? (outputTokens / generationMs) * 1000 : 0,
    };
}

function subRecord(source: unknown): Record<string, unknown> | undefined {
    return source !== null && typeof source === 'object'
        ? (source as Record<string, unknown>)
        : undefined;
}

/** Step.usage → StepUsage；无任何可投影字段时返回 undefined。 */
export function usageViewOf(usage: unknown): StepUsage | undefined {
    const root = subRecord(usage);
    if (root === undefined) {
        return undefined;
    }
    const view: StepUsage = {};
    const roundId = stringOf(root.roundId);
    if (roundId !== undefined) view.roundId = roundId;
    // 原始事实优先：有 raw 就从它重算 vendor/timing；否则回退到写入时的派生字段（旧数据）
    const raw = subRecord(root.raw);
    if (raw !== undefined) {
        view.raw = rawView(raw);
        const vendor = vendorFromRaw(view.raw);
        if (vendor !== undefined) view.vendor = vendor;
        const timing = timingFromRaw(view.raw);
        if (timing !== undefined) view.timing = timing;
    } else {
        const vendor = subRecord(root.vendor);
        if (vendor !== undefined) view.vendor = vendorView(vendor);
        const timing = subRecord(root.timing);
        if (timing !== undefined) view.timing = timingView(timing);
    }
    const pin = subRecord(root.pin);
    if (pin !== undefined) view.pin = pinView(pin);
    const runtime = subRecord(root.runtime);
    if (runtime !== undefined) view.runtime = runtimeView(runtime);
    const estimate = subRecord(root.estimate);
    if (estimate !== undefined) view.estimate = estimateView(estimate);
    const cost = subRecord(root.cost);
    if (cost !== undefined) view.cost = costView(cost);
    const estimatedCost = subRecord(root.estimatedCost);
    if (estimatedCost !== undefined) view.estimatedCost = costView(estimatedCost);
    if (
        view.vendor === undefined &&
        view.runtime === undefined &&
        view.estimate === undefined &&
        view.cost === undefined &&
        view.estimatedCost === undefined &&
        view.timing === undefined &&
        view.raw === undefined &&
        view.pin === undefined
    ) {
        return undefined;
    }
    return view;
}
