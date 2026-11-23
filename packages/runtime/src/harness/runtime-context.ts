import type { authz } from '@mazi/core';
import type { DelegationStack } from '../agent/stack.js';
import type { SuperAgent } from '../agent/super-agent.js';
import type { AnalysisStack } from '../analysis/stack.js';
import type { ProjectBlackboardService } from '../blackboard/index.js';
import type { RuntimeConfig } from '../config.js';
import type { EffectStore } from '../effects/effect-store.js';
import type { DefaultEventBus } from '../events/event-bus.js';
import type { StepEventEmitter } from '../events/step-events.js';
import type { FaultPipeline } from '../faults/index.js';
import type { HookRunner, SessionLifecycle } from '../hooks/index.js';
import type { RuntimeKernel } from '../kernel/index.js';
import type { RuntimePorts } from '../kernel/ports.js';
import type { FailureLedgerStore } from '../memory/failure-ledger.js';
import type { GoalStore } from '../memory/goal-store.js';
import type { MemoryManager } from '../memory/memory.js';
import type { PersonalMemoryService } from '../memory/personal-memory.js';
import type { MemoryStore } from '../memory/store.js';
import type { BehaviorRecorder } from '../observability/behavior-recorder.js';
import type { PluginHost } from '../plugins/index.js';
import type { PromptPackRegistry } from '../prompts/index.js';
import type { QuestionService } from '../question/service.js';
import type { IndependentVerifier } from '../verifier/index.js';
import type { ProjectWikiService, WikiService } from '../wiki/index.js';
import type { ModelResolver } from './model-resolver.js';
import type { RuntimeResources } from './resources.js';
import type { RoundRunner } from './round-runner.js';
import type { SessionFactory } from './session-factory.js';
import type { SessionIntake } from './session-intake.js';
import type { ToolPlane } from './tool-plane.js';
import type { TurnEngine } from './turn-engine.js';

/** 观测面：事件、钩子、生命周期、错误管线。 */
export interface ObservabilityPlane {
    bus: DefaultEventBus;
    hookRunner: HookRunner;
    lifecycle: SessionLifecycle;
    faultPipeline: FaultPipeline;
    stepEvents: StepEventEmitter;
}

/** 智能面：模型解析、轮次执行、决策与验收。 */
export interface IntelligencePlane {
    resolver: ModelResolver;
    roundRunner: RoundRunner;
    superAgent: SuperAgent;
    verifier: IndependentVerifier;
}

/** 工具面装配与注册表。 */
export interface ToolsPlane {
    registry: import('../tool-gateway/registry.js').RuntimeToolRegistry;
    plane: ToolPlane;
}

/** 会话面：创建、轮次执行与会话输入状态。 */
export interface SessionPlane {
    factory: SessionFactory;
    turns: TurnEngine;
    intake: SessionIntake;
    sessionIds: Map<string, string>;
    running: Map<string, AbortController>;
}

/** 记忆与存储面。 */
export interface MemoryPlane {
    goalStore: GoalStore;
    memoryManager: MemoryManager;
    personalMemory: PersonalMemoryService;
    effectStore: EffectStore;
    blackboard: ProjectBlackboardService;
    behaviorRecorder: BehaviorRecorder;
    questionService: QuestionService;
    failureLedger: FailureLedgerStore;
    wiki: WikiService;
    projectWiki?: ProjectWikiService;
}

/**
 * 装配面：构造期材料与运行期接入点。
 *
 * 这里的字段可变是刻意的：装配阶段逐项填入，之后由 ports / setter 维护；
 * 不再散落成 runtime 的 40 多个同级字段。
 */
export interface AssemblyPlane {
    config: RuntimeConfig;
    workspaceRoot?: string;
    commandPolicy: authz.CommandPolicy;
    approvalStore: authz.ApprovalStore;
    promptPacks: PromptPackRegistry;
    kernel: RuntimeKernel;
    ports: RuntimePorts;
    plugins: PluginHost;
    taskPlanningByDefault: boolean;
    maxReplans: number;
    memoryStore?: MemoryStore;
    resources: RuntimeResources;
}

/** 按平面分组的运行时对象图。 */
export interface RuntimeContext {
    observability: ObservabilityPlane;
    intelligence: IntelligencePlane;
    tools: ToolsPlane;
    session: SessionPlane;
    memory: MemoryPlane;
    /** features 段：被 disabledModules 关闭时为 undefined。 */
    analysis?: AnalysisStack;
    delegation?: DelegationStack;
    assembly: AssemblyPlane;
}

/** 先建空壳，构造器逐项填入（避免 40 个字段各自声明初始化表达式）。 */
export function createRuntimeContext(): RuntimeContext {
    return {
        observability: {} as ObservabilityPlane,
        intelligence: {} as IntelligencePlane,
        tools: {} as ToolsPlane,
        session: {} as SessionPlane,
        memory: {} as MemoryPlane,
        // features 段默认不装配；模块启用时才赋值。
        analysis: undefined,
        delegation: undefined,
        assembly: {} as AssemblyPlane,
    };
}
