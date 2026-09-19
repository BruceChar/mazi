import type {
    CostBreakdown,
    PricingSnapshot,
    RuntimeContextBreakdown,
    RuntimeOutputBreakdown,
    TokenUsage,
    VendorUsage,
} from '@mazi/core';
import type { RoundEstimate, RoundRawUsage } from '../gts/round-types.js';
import {
    appliedTierName,
    computeCostBreakdown,
    type PricingSchedule,
    type RoundOutcome,
    tierMultiplier,
    unitPricePerMTok,
} from '../provider/index.js';
import { estimateTokens } from '../token-estimator.js';
import { SEGMENT_CONTENT_MAX, truncateText } from './context-measure.js';

/** provider-runtime 上报的原始 usage 形状（由 RoundOutcome 推导，避免另立真相源） */
type ProviderUsage = NonNullable<RoundOutcome['metrics']['usage']>;
/** toRoundResult 产出（RoundResult 的最小事实面前缀） */
type RoundTextFacts = ReturnType<typeof toRoundResult>;

/** provider-runtime RoundOutcome → RoundResult（Step 回注所需最小事实面） */
export function toRoundResult(outcome: RoundOutcome): {
    text: string;
    reasoning: string;
    toolCalls: Array<{ callId: string; toolName: string; arguments: Record<string, unknown> }>;
    vendorUsage?: VendorUsage;
    raw?: RoundRawUsage;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
} {
    let text = '';
    let reasoning = '';
    for (const block of outcome.response.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'reasoning') reasoning += block.text;
    }
    const toolCalls = (outcome.response.toolCalls ?? []).map((toolCall) => ({
        callId: toolCall.callId,
        toolName: toolCall.name,
        arguments: toolCall.arguments,
    }));
    const usage = outcome.response.usage;
    const vendorUsage =
        usage === undefined
            ? undefined
            : {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheReadInputTokens: usage.cachedInputTokens,
                  cacheCreationInputTokens: usage.cachedWriteInputTokens,
                  reasoningOutputTokens: usage.reasoningTokens,
                  reportedByVendor: true,
              };
    // 原始轮次事实：provider/model + 原始 token 计数 + 耗时（入库优先，展示/计价可重算）
    const raw: RoundRawUsage | undefined =
        usage === undefined
            ? undefined
            : {
                  providerId: outcome.metrics.providerId,
                  modelId: outcome.metrics.modelId,
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  ...(usage.cachedInputTokens !== undefined
                      ? { cachedInputTokens: usage.cachedInputTokens }
                      : {}),
                  ...(usage.cachedWriteInputTokens !== undefined
                      ? { cachedWriteTokens: usage.cachedWriteInputTokens }
                      : {}),
                  ...(usage.reasoningTokens !== undefined
                      ? { reasoningTokens: usage.reasoningTokens }
                      : {}),
                  totalTokens: usage.totalTokens,
                  ttftMs: outcome.metrics.ttftMs ?? 0,
                  totalMs: outcome.metrics.totalMs,
              };
    return {
        text,
        reasoning,
        toolCalls,
        ...(vendorUsage ? { vendorUsage } : {}),
        ...(raw ? { raw } : {}),
        finishReason: outcome.response.finishReason,
        ttftMs: outcome.metrics.ttftMs ?? 0,
        totalMs: outcome.metrics.totalMs,
    };
}

/** 输出分段估算：reasoning / tool-call args / text（image/video 预留）。 */
export function outputBreakdown(result: RoundTextFacts): RuntimeOutputBreakdown | undefined {
    const reasoningTokens = estimateTokens(result.reasoning);
    const textTokens = estimateTokens(result.text);
    const toolCalls = result.toolCalls ?? [];
    const toolCallArgsTokens = toolCalls.reduce(
        (sum, call) => sum + estimateTokens(JSON.stringify(call)),
        0,
    );
    const totalOutputTokens = reasoningTokens + toolCallArgsTokens + textTokens;
    if (result.vendorUsage === undefined && totalOutputTokens === 0) {
        return undefined;
    }
    return {
        reasoningTokens,
        toolCallArgsTokens,
        textTokens,
        totalOutputTokens,
        contents: {
            reasoning: truncateText(result.reasoning, SEGMENT_CONTENT_MAX),
            toolCalls: truncateText(
                toolCalls.map((call) => JSON.stringify(call)).join('\n'),
                SEGMENT_CONTENT_MAX,
            ),
            text: truncateText(result.text, SEGMENT_CONTENT_MAX),
        },
    };
}

/** 输出估算与漂移：estimate.output − (vendor.output − vendor.reasoning)。 */
export function roundEstimate(result: RoundTextFacts): RoundEstimate | undefined {
    const outputTokens = estimateTokens(result.text);
    if (result.vendorUsage === undefined && outputTokens === 0) {
        return undefined;
    }
    const vendorNonReasoning = Math.max(
        0,
        (result.vendorUsage?.outputTokens ?? 0) - (result.vendorUsage?.reasoningOutputTokens ?? 0),
    );
    const drift = outputTokens - vendorNonReasoning;
    return {
        outputTokens,
        ...(result.vendorUsage !== undefined
            ? {
                  outputDriftTokens: drift,
                  outputDriftRate: vendorNonReasoning > 0 ? drift / vendorNonReasoning : undefined,
              }
            : {}),
    };
}

/** 估算 input 成本的初始缓存命中率（vendor 首次上报前使用）。 */
export const DEFAULT_ESTIMATED_CACHED_RATIO = 0.9;

/**
 * 估算缓存命中率的更新规则：vendor 上报了 cacheRead/input 就采用（clamp 到 [0,1]），
 * 否则沿用当前值（初始 DEFAULT_ESTIMATED_CACHED_RATIO）。命中率按会话记忆、跨轮更新。
 */
export function nextEstimatedCachedRatio(
    current: number,
    reportedCachedInput: number | undefined,
    vendorInput: number | undefined,
): number {
    if (reportedCachedInput !== undefined && vendorInput !== undefined && vendorInput > 0) {
        return Math.min(1, Math.max(0, reportedCachedInput / vendorInput));
    }
    return current;
}

/** 本轮成本拆分（厂商口径）。调用方需先确保 usage 与 pricing 均存在。 */
export function roundCost(usage: ProviderUsage, pricing: PricingSchedule): CostBreakdown {
    return computeCostBreakdown(usage, pricing, new Date());
}

/**
 * 以 runtime 估算 token 重算成本（与 vendor 成本对照）。调用方需先确保 pricing 与 estimate 均存在。
 *
 * 估算口径（docs/web/观测看板设计.md §2.4）：
 *   IN_price  = in × cachedRatio × cached_price + in × (1 − cachedRatio) × miss_price
 *   OUT_price = estimate_out_token × out_price
 * 其中 cachedRatio 取 vendor 实际缓存命中率（cacheRead / input）：估算是对实际请求的近似，
 * 命中结构沿用厂商上报。cachedRatio 缺省 0（全部按 miss 计）。
 */
export function roundEstimatedCost(
    contextUsage: RuntimeContextBreakdown,
    estimate: RoundEstimate,
    pricing: PricingSchedule,
    cachedInputRatio = 0,
): CostBreakdown {
    const estimatedInput = contextUsage.totalContextTokens;
    const ratio = Number.isFinite(cachedInputRatio)
        ? Math.min(1, Math.max(0, cachedInputRatio))
        : 0;
    const estimatedUsage: TokenUsage = {
        inputTokens: estimatedInput,
        cachedInputTokens: Math.round(estimatedInput * ratio),
        outputTokens: estimate.outputTokens,
        reasoningTokens: 0,
        totalTokens: estimatedInput + estimate.outputTokens,
    };
    return computeCostBreakdown(estimatedUsage, pricing, new Date());
}

/** 本轮计价快照（生效倍率后的单价，$/MTok），随 usage 入库。调用方需先确保 pricing 存在。 */
export function pricingSnapshot(pricing: PricingSchedule): PricingSnapshot {
    const hourUtc = new Date().getUTCHours();
    const effective = (component: 'input' | 'cache-read' | 'output' | 'reasoning'): number =>
        tierMultiplier(pricing, hourUtc, component) * (unitPricePerMTok(pricing, component) ?? 0);
    return {
        inputPerMTok: effective('input'),
        cachedInputPerMTok: effective('cache-read'),
        outputPerMTok: effective('output'),
        ...(pricing.base.reasoningPerMTok !== undefined
            ? { reasoningPerMTok: effective('reasoning') }
            : {}),
        currency: pricing.currency,
        version: pricing.version,
        tier: appliedTierName(pricing, hourUtc),
    };
}
