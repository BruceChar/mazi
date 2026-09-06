import type { FlagSnapshot } from './flags.js';
import type { AcceptanceSpec, GoalContract } from './goal.js';
import type { MemoryStore } from './memory.js';
import type { HarnessEvent } from './observability.js';
import type { Planner } from './planner.js';
import type { LLMDriver } from './provider.js';
import type { ObservationPayload, Session } from './session.js';
import type { ToolExecutionResult } from './tool.js';

/** 策略注入点：L2 执行/观察/反思模块句柄，方法级契约由对应包里程碑定义 */
export type Executor = object;

/** 工具执行结果的结构化观察上下文 */
export interface ObservationContext {
    sessionId: string;
    turnId: string;
    toolName: string;
    result: ToolExecutionResult;
}

/** Observer：把工具执行结果转换为可回注的结构化观察载荷 */
export interface Observer {
    observeToolResult(ctx: ObservationContext): Promise<ObservationPayload>;
}

/** 反射评估输入：对照子任务验收规格 */
export interface ReflectionRequest {
    sessionId: string;
    turnId: string;
    success: AcceptanceSpec;
    outcomeOk: boolean;
    finalMessage?: string;
}

/** 反射结论：accepted=false 时由调用方按 failureSignals 处理 */
export interface ReflectionVerdict {
    accepted: boolean;
    reason?: string;
    matchedConditions: string[];
    failedConditions: string[];
}

/** Reflector：独立于执行器的验收/评估器 */
export interface Reflector {
    reflect(request: ReflectionRequest): Promise<ReflectionVerdict>;
}

/** 策略能力声明 */
export interface StrategyCapabilities {
    needsGoal: boolean;
    needsPlan: boolean;
    needsExecute: boolean;
    /** false 时 observer 不实例化 */
    needsObserve: boolean;
    needsReflect: boolean;
    needsPersistentState: boolean;
}

/** 目标结构的轻量预估，用于策略评分 */
export interface PlanEstimate {
    estimatedTurns: number;
    hasIrreversibleActions: boolean;
    constraintCount: number;
    estimatedCostUsd?: number;
}

/** 策略执行产生的事件流 */
export type StrategyEvent = HarnessEvent;

/** 可插拔执行策略 */
export interface HarnessStrategy {
    id: string;
    version: string;
    capabilities: StrategyCapabilities;
    score(goal: GoalContract, estimate?: PlanEstimate): number;
    run(ctx: StrategyContext): AsyncIterable<StrategyEvent>;
}

/** 策略执行上下文：已装配依赖的注入点 */
export interface StrategyContext {
    session: Session;
    planner?: Planner;
    executor?: Executor;
    observer?: Observer;
    reflector?: Reflector;
    memory: MemoryStore;
    driver: LLMDriver;
    flags: FlagSnapshot;
    emit: (event: HarnessEvent) => void;
}
