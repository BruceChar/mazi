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
    TocAnalysisStatus,
    TocAnalysisView,
    TocFeedbackView,
    TocIterationView,
    TocRecordView,
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
export { type AnalyzeTocInput, TocAnalyst, type TocAnalystDeps } from './analysis/toc-analyst.js';
// TOC / 独立分析 / 反馈（Iterations 面板的数据面；不进 Goal 坐标系）
export {
    buildIterations,
    MemoryTocStore,
    SqliteTocStore,
    type TocAnalysisRecord,
    type TocFeedbackRecord,
    type TocRecord,
    type TocStore,
} from './analysis/toc-store.js';
// 模型目录与计费数据架构（catalog）：目录事实 / 同步 / 快照 / 路由 / 账本
export * from './provider/catalog/index.js';
export type {
    ProviderConfig,
    RuntimeConfig,
    ToolCallResult,
    ToolConfig,
} from './config.js';
export type {
    FileRuntimeConfig,
    RuntimeSettingsFile,
    VendorPricingSource,
} from './configs/config-io.js';
export {
    configOverview,
    loadRuntimeConfig,
    loadRuntimeSettings,
    resolveScopedPermission,
    resolveVendorPricingSource,
    saveRuntimeSettings,
    toRuntimeConfig,
} from './configs/config-io.js';
export {
    ContextManager,
    type ContextAssistantTurn,
    type ContextContribution,
    type ContextManagerOptions,
    type ContextSecretRef,
    type ContextToolObservation,
    HarnessRuntime,
    parseSecretRef,
    type RunOptions,
    SecretRedactionUnavailableError,
    type SecretRedactor,
    secretServiceRedactor,
    SECRET_REF_FIELD,
    serializeSecretRef,
} from './harness/index.js';
export type { GoalStore } from './memory/goal-store.js';
// 观测层（事件总线；apps 直接消费）
export type { EventBusOptions, NewEventInput } from './events/event-bus.js';
export { ConsoleSink, DefaultEventBus, newHarnessEvent } from './events/event-bus.js';
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
export type { SecretsFile } from './secrets.js';
export {
    apiKeyStatus,
    loadSecrets,
    maskApiKey,
    saveProviderApiKey,
    withProviderSecrets,
} from './secrets.js';
export type { GoalRunResult } from './strategy/goal-strategy.js';
export type { ApprovalSettlement, PendingApproval } from './tool-gateway/approval.js';
export { ApprovalBroker, DEFAULT_APPROVAL_TTL_MS } from './tool-gateway/approval.js';
export { RuntimeToolGateway } from './tool-gateway/permission.js';
export { RuntimePolicyAuditSink } from './tool-gateway/policy-audit.js';
