/**
 * @mazi/runtime —— Goal/Task/Step 坐标系的执行实现聚合包（C5 收口）。
 */

export type { ProviderModelInfo, ProviderModelPricing } from '@mazi/core';
// Goal/Task/Step 坐标投影（审计/API/WebUI 消费；类型已上移到 @mazi/libs，此处 re-export 保持兼容）
export type {
    GoalNodeView,
    GoalTreeSnapshot,
    StepUsage,
    StepView,
    TaskNodeView,
} from '@mazi/libs';
export {
    buildPricingAnalysisPrompt,
    builtinModelsFor,
    builtinVendors,
    type CatalogModel,
    DEEPSEEK_PEAK_TIERS,
    DEEPSEEK_PRICING_SOURCE,
    DEEPSEEK_PRICING_VERSION,
    type DiscoverModelsOptions,
    deepseekTierOf,
    discoverModels,
    htmlToText,
    type ModelDiscoveryResult,
    type ParsedDeepseekPricing,
    type ParsedModelPricing,
    parseAgentPricingJson,
    parseDeepseekPricingPage,
    peakMultiplierOf,
} from '@mazi/provider';
// 模型目录与计费数据架构（catalog）：目录事实 / 同步 / 快照 / 路由 / 账本
export * from './catalog/index.js';
export type {
    ProviderConfig,
    RuntimeConfig,
    ToolCallResult,
    ToolConfig,
    ToolSpecLike,
} from './config.js';
export type { FileRuntimeConfig, RuntimeSettingsFile } from './config-io.js';
export {
    configOverview,
    loadRuntimeConfig,
    loadRuntimeSettings,
    resolveScopedPermission,
    saveRuntimeSettings,
    toRuntimeConfig,
} from './config-io.js';
export type { GoalStore } from './memory/goal-store.js';
// 观测层（事件总线；apps 直接消费）
export type { EventBusOptions, NewEventInput } from './observability/event-bus.js';
export { ConsoleSink, DefaultEventBus, newHarnessEvent } from './observability/event-bus.js';
export type { MaziPaths } from './paths.js';
export {
    defaultConfigDir,
    defaultDbPath,
    defaultEventDir,
    ensureMaziDirs,
    maziHome,
    maziPaths,
} from './paths.js';
export type { PricingSchedule } from './provider/pricing.js';
export type { PricingPage, PricingPageAnalyst } from './provider/pricing-analyst.js';
export { createPricingAnalyst } from './provider/pricing-analyst.js';
export type { RunOptions } from './runtime.js';
export { HarnessRuntime } from './runtime.js';
export type { GoalRunResult } from './strategy/goal-strategy.js';
export type { ApprovalSettlement, PendingApproval } from './tool-gateway/approval.js';
export { ApprovalBroker, DEFAULT_APPROVAL_TTL_MS } from './tool-gateway/approval.js';
export { RuntimeToolGateway } from './tool-gateway/permission.js';
export { RuntimePolicyAuditSink } from './tool-gateway/policy-audit.js';
