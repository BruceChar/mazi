import type {
    BudgetSlice,
    Capacity,
    EventBus,
    FlagSnapshot,
    GoalContract,
    HarnessEvent,
    PermissionLevel,
    SandboxSpec,
    ToolRegistry,
    ToolSpec,
    Turn,
    TurnContract,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { newHarnessEvent } from '@mazi/observability';
import type { SimpleRouter } from '@mazi/provider-llm';
import { equalBudgetSlices, validateBudgetConservation } from './budget.js';
import {
    convergePermission,
    deriveSandboxNetworkAllowInternet,
    permissionRank,
    resolveAllowedTools,
} from './tool-resolver.js';

/** planner 装配依赖 */
export interface PlannerDeps {
    /** 工具注册表：Goal 工具域 → ToolSpec */
    toolRegistry: ToolRegistry;
    /** 简单路由器（读 turn.contract.tags，能力+成本，MVP simple 模式） */
    router: SimpleRouter;
    /** 事件总线（emit 永不阻塞） */
    bus: EventBus;
    /** Session 级 Flag 快照（缺省用空快照） */
    flagSnapshot?: FlagSnapshot;
    /** sandbox.enabled 默认值（生产恒 true） */
    sandboxEnabled?: boolean;
}

export interface PlannerResult {
    contracts: TurnContract[];
    rejected?: string[];
}

/**
 * planner 派生校验纯函数：返回违规描述列表（空=通过）。
 * 三条收窄规则（v1.2 §3.2.3 / 验收 A2）：工具收窄 / 权限收窄 / 预算守恒。
 */
export function validateTurnContract(goal: GoalContract, contract: TurnContract): string[] {
    const issues: string[] = [];
    for (const req of contract.requiredTools) {
        if (req.nameOrCapability === 'all-registry') {
            continue;
        }
        if (
            goal.allowedTools !== 'all-registry' &&
            !goal.allowedTools.includes(req.nameOrCapability)
        ) {
            issues.push(`工具收窄违规：${req.nameOrCapability} 不在 allowedTools 内`);
        }
    }
    if (permissionRank(contract.maxPermission) > permissionRank(goal.permissionCeiling)) {
        issues.push(
            `权限收窄违规：maxPermission(${contract.maxPermission}) > ceiling(${goal.permissionCeiling})`,
        );
    }
    issues.push(...validateBudgetConservation(goal, [contract.budget]));
    return issues;
}

function emptyFlagSnapshot(): FlagSnapshot {
    return {
        values: {},
        trace: [],
        isEnabled: () => false,
        getNumber: () => undefined,
        getString: () => undefined,
    };
}

function baseEvent(type: HarnessEvent['type'], sessionId: string, turnId?: string): HarnessEvent {
    return newHarnessEvent({ type, sessionId, turnId });
}

/** planner 装配失败错误（required 工具缺失、路由无候选等） */
export class PlannerCapacityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlannerCapacityError';
    }
}

function defaultFailureSignals(): TurnContract['failureSignals'] {
    return [
        { kind: 'tool-error', action: 'retry', maxRetries: 1 },
        { kind: 'budget-exceeded', action: 'abort-turn' },
        { kind: 'acceptance-failed', action: 'abort-turn' },
    ];
}

function buildSandbox(goal: GoalContract, allowedTools: ToolSpec[], enabled: boolean): SandboxSpec {
    const touchesNetwork = allowedTools.some((tool) => tool.sideEffects.includes('net'));
    return {
        enabled,
        network: {
            allowInternet: touchesNetwork ? deriveSandboxNetworkAllowInternet(goal) : false,
        },
    };
}

/**
 * MVP Planner（feature F9，MVP 文档 §3.2/§5.1/§8）：
 * plan(goal)：Goal → 默认 1 个 Turn 的线性分解（结构支持 N）+ 三条派生校验 + 均分预算切片；
 *             违规 → emit plan.invalid 并拒绝出计划（验收 A2/A3）。
 * assembleCapacity(turn, goal)：Goal 工具域解析白名单 + SimpleRouter 选模型 + 权限收敛 + sandbox。
 */
export class MvpPlanner {
    constructor(private readonly deps: PlannerDeps) {}

    plan(goal: GoalContract, turnCount = 1): PlannerResult {
        const slices = equalBudgetSlices({
            goalBudget: goal.budget,
            goalTermination: goal.termination,
            turnCount,
        });
        const contracts: TurnContract[] = [];
        for (let i = 0; i < turnCount; i++) {
            const slice = slices[i] ?? emptyBudgetSlice(goal);
            const requiredTools =
                (goal.metadata?.requiredTools as TurnContract['requiredTools']) ?? [];
            const tooling =
                requiredTools.length > 0 ||
                goal.allowedTools === 'all-registry' ||
                (Array.isArray(goal.allowedTools) && goal.allowedTools.length > 0);
            const contract: TurnContract = {
                turnContractId: ulid(),
                parentGoalId: goal.goalId,
                parentPlanNodeId: `node-${i + 1}`,
                statement: goal.statement,
                tags: tooling ? ['tools', 'general'] : ['general'],
                success: goal.success,
                failureSignals:
                    (goal.metadata?.failureSignals as TurnContract['failureSignals'] | undefined) ??
                    defaultFailureSignals(),
                requiredTools,
                maxPermission: goal.permissionCeiling,
                budget: slice,
                expectedSideEffects: [],
                rollback: {
                    strategy: goal.rollbackPolicy.strategy,
                    description: goal.rollbackPolicy.description,
                },
                termination: {
                    maxSteps: goal.termination.maxSteps,
                    timeoutMs: goal.budget.timeoutMs ?? goal.termination.timeoutMs,
                    conditions: goal.termination.conditions,
                },
            };
            contracts.push(contract);
        }
        const issues: string[] = [];
        for (const contract of contracts) {
            issues.push(...validateTurnContract(goal, contract));
        }
        if (issues.length > 0) {
            this.deps.bus.emit({
                ...baseEvent('plan.invalid', goal.sessionId),
                payload: { goalId: goal.goalId, issues },
            });
            return { contracts: [], rejected: issues };
        }
        this.deps.bus.emit({
            ...baseEvent('plan.created', goal.sessionId),
            payload: {
                goalId: goal.goalId,
                turnContractIds: contracts.map((c) => c.turnContractId),
            },
        });
        return { contracts };
    }

    /**
     * Turn 契约 → 运行时授权产物（Capacity）。
     * 白名单 = Goal 工具域内注册表可解析的全部工具（含未 required 者，供模型按需调用）；
     * required 声明缺失 → 装配失败（PlannerCapacityError）；optional 缺失 → emit capacity.degraded。
     */
    assembleCapacity(turn: Turn, goal: GoalContract): Capacity {
        const contract = turn.contract;
        // 白名单解析
        const resolution = resolveAllowedTools(goal, this.deps.toolRegistry);
        const missingRequired = contract.requiredTools.filter(
            (req) =>
                req.required &&
                !resolution.tools.some((tool) => tool.name === req.nameOrCapability),
        );
        if (missingRequired.length > 0) {
            const names = missingRequired.map((r) => r.nameOrCapability);
            this.deps.bus.emit({
                ...baseEvent('capacity.degraded', turn.sessionId, turn.turnId),
                payload: { turnId: turn.turnId, missingRequired: names },
            });
            throw new PlannerCapacityError(`required 工具缺失：${names.join(', ')}`);
        }
        if (resolution.missingOptional.length > 0) {
            this.deps.bus.emit({
                ...baseEvent('capacity.degraded', turn.sessionId, turn.turnId),
                payload: { turnId: turn.turnId, missingOptional: resolution.missingOptional },
            });
        }
        // 路由：唯一信号源 = turn.contract.tags（验收 A4）
        const candidate = this.deps.router.select(contract.tags);
        const permission = convergePermission(contract.maxPermission, resolution.tools);
        const sandbox = buildSandbox(goal, resolution.tools, this.deps.sandboxEnabled ?? true);
        this.deps.bus.emit({
            ...baseEvent('provider.selected', turn.sessionId, turn.turnId),
            attributes: {
                'gen_ai.request.model': candidate.model.modelId,
                'gen_ai.provider.name': candidate.provider.id,
                'harness.turn_tags': contract.tags,
            },
            payload: { turnId: turn.turnId, model: candidate.model },
        });
        const capacity: Capacity = {
            model: candidate.model,
            tools: resolution.tools,
            permission: permission as PermissionLevel,
            budget: contract.budget,
            sandbox,
            flags: this.deps.flagSnapshot ?? emptyFlagSnapshot(),
        };
        this.deps.bus.emit({
            ...baseEvent('capacity.assembled', turn.sessionId, turn.turnId),
            attributes: {
                'harness.permission_level': capacity.permission,
                'harness.turn_tags': contract.tags,
            },
            payload: {
                turnId: turn.turnId,
                model: candidate.model,
                toolCount: capacity.tools.length,
            },
        });
        return capacity;
    }
}

function emptyBudgetSlice(goal: GoalContract): BudgetSlice {
    return {
        maxSteps: goal.budget.maxSteps,
        maxTokens: goal.budget.maxTokens,
        timeoutMs: goal.budget.timeoutMs,
    };
}
