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
export { builtinModelsFor, builtinVendors, type CatalogModel } from '@mazi/provider';
// 模型目录与计费数据架构（catalog）：目录事实 / 同步 / 快照 / 路由 / 账本
export * from './catalog/index.js';
export type {
    ProviderConfig,
    RuntimeConfig,
    ToolCallResult,
    ToolConfig,
    ToolSpecLike,
} from './config.js';
export type { FileRuntimeConfig } from './config-io.js';
export { configOverview, loadRuntimeConfig, toRuntimeConfig } from './config-io.js';
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
export type { RunOptions } from './runtime.js';
export { HarnessRuntime } from './runtime.js';
export type { GoalRunResult } from './strategy/goal-strategy.js';
