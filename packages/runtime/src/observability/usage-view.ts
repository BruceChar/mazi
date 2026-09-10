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
    const vendor = subRecord(root.vendor);
    if (vendor !== undefined) view.vendor = vendorView(vendor);
    const runtime = subRecord(root.runtime);
    if (runtime !== undefined) view.runtime = runtimeView(runtime);
    const estimate = subRecord(root.estimate);
    if (estimate !== undefined) view.estimate = estimateView(estimate);
    const cost = subRecord(root.cost);
    if (cost !== undefined) view.cost = costView(cost);
    const estimatedCost = subRecord(root.estimatedCost);
    if (estimatedCost !== undefined) view.estimatedCost = costView(estimatedCost);
    const timing = subRecord(root.timing);
    if (timing !== undefined) view.timing = timingView(timing);
    if (
        view.vendor === undefined &&
        view.runtime === undefined &&
        view.estimate === undefined &&
        view.cost === undefined &&
        view.estimatedCost === undefined &&
        view.timing === undefined
    ) {
        return undefined;
    }
    return view;
}
