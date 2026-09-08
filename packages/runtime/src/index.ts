/** @mazi/runtime —— 收敛后的执行实现聚合包（core 契约 / provider 接入之外所有运行期实现）。 */
export type { ProviderConfig, RuntimeConfig, ToolConfig, ToolSpecLike } from './config.js';
export type { FileRuntimeConfig } from './config-io.js';
export { configOverview, loadRuntimeConfig, toRuntimeConfig } from './config-io.js';
export { buildGoal } from './goal-factory.js';
export type { GoalStore } from './memory/goal-store.js';
// 观测层（原 @mazi/observability，apps 直接消费）
export type { EventBusOptions, NewEventInput } from './observability/event-bus.js';
export { ConsoleSink, DefaultEventBus, newHarnessEvent } from './observability/event-bus.js';
// Goal/Task/Step 坐标路径（C3-C4 迁移面）
export type {
    GoalNodeView,
    GoalTreeSnapshot,
    StepView,
    TaskNodeView,
} from './observability/goal-snapshot.js';
export type { MaziPaths } from './paths.js';
export {
    defaultConfigDir,
    defaultDbPath,
    defaultEventDir,
    ensureMaziDirs,
    maziHome,
    maziPaths,
} from './paths.js';
export type {
    CreateSessionOptions,
    RunOptions,
    RunResult,
    SessionGoalOverrides,
} from './runtime.js';
export { HarnessRuntime } from './runtime.js';
export type { GoalRunResult } from './strategy/goal-strategy.js';
