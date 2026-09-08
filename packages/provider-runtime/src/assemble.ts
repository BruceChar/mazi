/**
 * assemble —— provider-runtime 装配层（AHF_RUNTIME_PROVIDER §2/§9/§7.4）。
 *
 * 把 config/registry/round-executor/health/breaker/limiter/profile/store/supply 组装为一个
 * 可整体使用的 ProviderStack。harness（M6 接线）只需：
 *   const stack = await assembleProviderStack({ configs, adapters, profileStore })
 *   const outcome = await stack.round.execute(request, [stack.candidate(providerId)])
 *   await stack.close()
 *
 * faux 轮次（adapter='faux'）由 candidate() 标记 synthetic，不落画像/账本（§9.3）。
 */

import type { LLMRequest } from '@mazi/core';
import type { ProviderConfig } from './config.js';
import { HealthTracker } from './health.js';
import { EndpointLimiter } from './limiter.js';
import { type RoundCandidate, RoundExecutor, type RoundMetrics } from './orchestrator.js';
import { ProfileCollector, type ProfileSnapshot } from './profile.js';
import { type AdapterCatalog, ProviderRegistry } from './registry.js';
import { CircuitBreaker, type RetryPolicyTable } from './retry.js';
import type { ProfileStore } from './store.js';
import { type ProfileQueryResult, RoutingSupply } from './supply.js';

export interface AssembleProviderStackOptions {
    configs: ProviderConfig[];
    /** adapter 工厂注入（registry 不 import 厂商 SDK） */
    adapters: AdapterCatalog;
    /** faux 防线（§9.3）；生产装配必须 false */
    allowFaux?: boolean;
    env?: Record<string, string | undefined>;
    /** §7.4：冷启动加载 / close 时快照 */
    profileStore?: ProfileStore;
    retryPolicy?: RetryPolicyTable;
    maxAttempts?: number;
    /** 端点/模型级缺省超时 */
    timeoutMs?: number;
    onMetrics?: (metrics: RoundMetrics) => void;
    now?: () => number;
}

export interface AssembledProviderStack {
    registry: ProviderRegistry;
    supply: RoutingSupply;
    round: RoundExecutor;
    health: HealthTracker;
    breaker: CircuitBreaker;
    collector: ProfileCollector;
    config: (providerId: string) => ProviderConfig | undefined;
    /** 由 providerId 组装候选（pricing/timeout/synthetic 取自配置） */
    candidate: (providerId: string, modelId?: string) => RoundCandidate;
    /** 持久化画像快照（若有 profileStore） */
    close: () => Promise<void>;
}

export async function assembleProviderStack(
    options: AssembleProviderStackOptions,
): Promise<AssembledProviderStack> {
    const now = options.now ?? Date.now;
    const allowFaux = options.allowFaux ?? false;
    const env = options.env ?? {};

    const registry = new ProviderRegistry(
        { allowFaux, adapters: options.adapters, env },
        options.configs,
    );
    const health = new HealthTracker(options.retryPolicy);
    const breaker = new CircuitBreaker();
    const collector = new ProfileCollector({ now });
    const limiter = new EndpointLimiter({
        limits: (providerId) => options.configs.find((c) => c.id === providerId)?.limits ?? {},
        now,
    });

    const configOf = (providerId: string): ProviderConfig | undefined =>
        options.configs.find((c) => c.id === providerId);

    // §7.4 冷启动：ProfileStore 快照作为画像初值（新轮次实时覆盖）
    const preloaded: ProfileSnapshot | null = options.profileStore
        ? await options.profileStore.load()
        : null;
    const profileQuery = (providerId: string, modelId: string): ProfileQueryResult | null => {
        const livePerf = collector.performance(providerId, modelId);
        const liveEcon = collector.economics(providerId, modelId);
        if (livePerf || liveEcon) {
            return {
                ...(livePerf ? { performance: livePerf } : {}),
                ...(liveEcon ? { economics: liveEcon } : {}),
            };
        }
        const key = `${providerId}/${modelId}`;
        const entry = preloaded?.models[key];
        if (!entry) return null;
        return { performance: entry.performance, economics: entry.economics };
    };

    const supply = new RoutingSupply(options.configs, {
        health: (providerId) => health.score(providerId),
        breakerOpen: (providerId) => breaker.state(providerId) === 'open',
        profile: profileQuery,
    });

    // RoundMetrics → 画像事实（§7.2：画像输入只有 RoundMetrics 一条路径）；转发调用方 onMetrics
    const handleMetrics = (metrics: RoundMetrics): void => {
        collector.record({
            providerId: metrics.providerId,
            modelId: metrics.modelId,
            ok: metrics.ok,
            usage: metrics.usage,
            ttftMs: metrics.ttftMs,
            totalMs: metrics.totalMs,
            errorCode: metrics.errorCode,
            abortedBy: metrics.abortedBy,
            costUsd: metrics.costUsd,
            attempts: metrics.attempts,
            synthetic: metrics.synthetic,
            at: metrics.at,
        });
        options.onMetrics?.(metrics);
    };
    const round = new RoundExecutor({
        limiter,
        breaker,
        health,
        retryPolicy: options.retryPolicy,
        maxAttempts: options.maxAttempts,
        timeoutMs: options.timeoutMs,
        onMetrics: handleMetrics,
        now,
    });

    const candidate = (providerId: string, modelId?: string): RoundCandidate => {
        const config = configOf(providerId);
        if (!config) {
            throw new Error(`assemble.candidate: unknown provider '${providerId}'`);
        }
        const provider = registry.get(providerId);
        const resolvedModel = modelId ?? provider.defaultModel ?? config.models[0]?.id;
        const modelCfg = config.models.find((m) => m.id === resolvedModel);
        return {
            providerId,
            provider,
            ...(resolvedModel ? { modelId: resolvedModel } : {}),
            ...(modelCfg?.timeoutMs !== undefined || config.timeoutMs !== undefined
                ? { timeoutMs: modelCfg?.timeoutMs ?? config.timeoutMs }
                : {}),
            ...(modelCfg?.pricing ? { pricing: modelCfg.pricing } : {}),
            ...(config.adapter === 'faux' ? { synthetic: true } : {}),
        };
    };

    const close = async (): Promise<void> => {
        if (options.profileStore) {
            const snapshot = collector.snapshot();
            if (Object.keys(snapshot.models).length > 0) {
                await options.profileStore.save(snapshot);
            }
        }
    };

    return {
        registry,
        supply,
        round,
        health,
        breaker,
        collector,
        config: configOf,
        candidate,
        close,
    };
}
