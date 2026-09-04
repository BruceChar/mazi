import type {
    Capacity,
    EventBus,
    FlagSnapshot,
    GoalContract,
    HarnessEvent,
    ToolRegistry,
    ToolRequirement,
    ToolResolution,
    ToolSpec,
    Turn,
    TurnContract,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import type { ProviderJson } from '@mazi/provider-llm';
import { normalizeProvider, SimpleRouter } from '@mazi/provider-llm';
import { describe, expect, it } from 'vitest';
import { equalBudgetSlices, MIN_TURN_BUDGET_USD, validateBudgetConservation } from './budget.js';
import { MvpPlanner, PlannerCapacityError, validateTurnContract } from './planner.js';

function stubFlag(): FlagSnapshot {
    return {
        values: {},
        trace: [],
        isEnabled: () => false,
        getNumber: () => undefined,
        getString: () => undefined,
    };
}

function makeBus(): { bus: EventBus; events: HarnessEvent[] } {
    const events: HarnessEvent[] = [];
    const bus = {
        emit: (e: HarnessEvent) => void events.push(e),
        subscribe: () => () => undefined,
        replay: () => [],
    } as unknown as EventBus;
    return { bus, events };
}

function provider(id: string, price: number): ReturnType<typeof normalizeProvider> {
    const json: ProviderJson = {
        id,
        vendor: 'test',
        tags: ['tools'],
        models: [
            {
                id: `${id}-m`,
                contextWindow: 64000,
                supportsTools: true,
                supportsThinking: true,
                supportsVision: false,
            },
        ],
        pricing: {
            currency: 'USD',
            base: { inputPerMTok: price, outputPerMTok: price },
            tiers: [],
            effectiveAt: 0,
            version: '1.0',
        },
        health: { score: 1 },
    };
    return normalizeProvider(json);
}

function fsReadSpec(): ToolSpec {
    return {
        name: 'fs.read',
        description: '读取文件',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: ['fs'],
    };
}

function registryWith(specs: ToolSpec[]): ToolRegistry {
    return {
        resolve(requirements: ToolRequirement[]): ToolResolution {
            const byName = new Map(specs.map((s) => [s.name, s]));
            const tools: ToolSpec[] = [];
            const missingRequired: string[] = [];
            const missingOptional: string[] = [];
            for (const req of requirements) {
                const found = byName.get(req.nameOrCapability);
                if (found) {
                    tools.push(found);
                } else if (req.required) {
                    missingRequired.push(req.nameOrCapability);
                } else {
                    missingOptional.push(req.nameOrCapability);
                }
            }
            return { tools, missingRequired, missingOptional };
        },
        list() {
            return [...specs];
        },
    };
}

function goal(partial: Partial<GoalContract>): GoalContract {
    return {
        goalId: ulid(),
        sessionId: 'sess-p',
        statement: '读取文件并汇报',
        success: { conditions: [], description: '' },
        constraints: [],
        permissionCeiling: 'read-only',
        budget: { maxCostUsd: 1, reserveRatio: 0.2 },
        termination: { maxSteps: 8 },
        rollbackPolicy: { strategy: 'none' },
        strategyHints: ['complex'],
        ...partial,
        allowedTools: partial.allowedTools ?? ['all-registry'],
    };
}

function makePlanner(
    bus: EventBus,
    registry: ToolRegistry,
    providers: ReturnType<typeof normalizeProvider>[],
): MvpPlanner {
    return new MvpPlanner({
        toolRegistry: registry,
        router: new SimpleRouter(providers),
        bus,
        flagSnapshot: stubFlag(),
        sandboxEnabled: true,
    });
}

function baseTurn(goal: GoalContract, contract: TurnContract): Turn {
    return {
        turnId: ulid(),
        sessionId: goal.sessionId,
        contract,
        stepIds: [],
        status: 'pending',
        attempt: 1,
    };
}

describe('派生校验纯函数（MVP v1.0 §8 F9 / 验收 A2）', () => {
    it('requiredTools ⊄ allowedTools → 违规', () => {
        const g = goal({ allowedTools: ['fs.read'] });
        const contract: TurnContract = {
            turnContractId: ulid(),
            parentGoalId: g.goalId,
            parentPlanNodeId: 'n1',
            statement: g.statement,
            tags: ['general'],
            success: g.success,
            failureSignals: [],
            requiredTools: [{ nameOrCapability: 'fs.write', required: true }],
            maxPermission: 'read-only',
            budget: { maxCostUsd: 0.8 },
            expectedSideEffects: [],
            rollback: { strategy: 'none' },
            termination: { maxSteps: 8 },
        };
        const issues = validateTurnContract(g, contract);
        expect(issues.join(' ')).toContain('工具收窄');
    });

    it('maxPermission > ceiling → 违规', () => {
        const g = goal({ allowedTools: ['fs.read'] });
        const contract: TurnContract = {
            turnContractId: ulid(),
            parentGoalId: g.goalId,
            parentPlanNodeId: 'n1',
            statement: g.statement,
            tags: ['general'],
            success: g.success,
            failureSignals: [],
            requiredTools: [],
            maxPermission: 'autonomous',
            budget: { maxCostUsd: 0.8 },
            expectedSideEffects: [],
            rollback: { strategy: 'none' },
            termination: { maxSteps: 8 },
        };
        const issues = validateTurnContract(g, contract);
        expect(issues.join(' ')).toContain('权限收窄');
    });
});

describe('plan（MVP v1.0 §8 F9）', () => {
    it('单 Turn 分解：预算切片 = 可分配额，plan.created 事件', () => {
        const { bus, events } = makeBus();
        const planner = makePlanner(bus, registryWith([fsReadSpec()]), [provider('a', 1)]);
        const g = goal({
            allowedTools: ['fs.read'],
            metadata: { requiredTools: [{ nameOrCapability: 'fs.read', required: true }] },
        });
        const contracts = planner.plan(g).contracts;
        expect(contracts).toHaveLength(1);
        expect(contracts[0]?.statement).toBe(g.statement);
        expect(contracts[0]?.tags).toContain('tools');
        expect(contracts[0]?.budget.maxCostUsd).toBeCloseTo(0.8, 6);
        expect(events.some((e) => e.type === 'plan.created')).toBe(true);
    });

    it('越权工具域 → 拒绝出计划并 emit plan.invalid', () => {
        const { bus, events } = makeBus();
        const planner = makePlanner(bus, registryWith([fsReadSpec()]), [provider('a', 1)]);
        const g = goal({
            allowedTools: ['fs.read'],
            metadata: { requiredTools: [{ nameOrCapability: 'fs.write', required: true }] },
        });
        const result = planner.plan(g);
        expect(result.contracts).toEqual([]);
        expect(result.rejected?.join(' ')).toContain('工具收窄');
        expect(events.some((e) => e.type === 'plan.invalid')).toBe(true);
    });
});

describe('预算切片与守恒（验收 A3）', () => {
    it('均分 + 单 Turn 切片 = 可分配额', () => {
        const [single] = equalBudgetSlices({
            goalBudget: { maxCostUsd: 1, reserveRatio: 0.2 },
            turnCount: 1,
        });
        expect(single?.maxCostUsd).toBeCloseTo(0.8, 6);
    });
    it('下限保护：极小预算不低于 MIN_TURN_BUDGET_USD', () => {
        const slices = equalBudgetSlices({
            goalBudget: { maxCostUsd: 0.001, reserveRatio: 0.2 },
            turnCount: 1,
        });
        expect(slices[0]?.maxCostUsd).toBe(MIN_TURN_BUDGET_USD);
    });
    it('validateBudgetConservation：切片总和超可分配额 → 违规', () => {
        const g = goal({ budget: { maxCostUsd: 1, reserveRatio: 0.2 } });
        const issues = validateBudgetConservation(g, [{ maxCostUsd: 0.9 }]);
        expect(issues.length).toBeGreaterThan(0);
        expect(validateBudgetConservation(g, [{ maxCostUsd: 0.8 }])).toEqual([]);
    });
});

describe('assembleCapacity（A4 / F9）', () => {
    it('路由读 turn.tags 选最便宜 provider；capacity 组装完整', () => {
        const { bus, events } = makeBus();
        const planner = makePlanner(bus, registryWith([fsReadSpec()]), [
            provider('expensive', 5),
            provider('cheap', 1),
        ]);
        const g = goal({ allowedTools: ['fs.read'] });
        const contract = planner.plan(g).contracts[0];
        const turn = baseTurn(g, contract as TurnContract);
        const capacity: Capacity = planner.assembleCapacity(turn, g);
        expect(capacity.model.providerId).toBe('cheap');
        expect(capacity.tools.map((t) => t.name)).toEqual(['fs.read']);
        expect(capacity.permission).toBe('read-only');
        expect(capacity.budget.maxCostUsd).toBeCloseTo(0.8, 6);
        expect(events.some((e) => e.type === 'provider.selected')).toBe(true);
        expect(events.some((e) => e.type === 'capacity.assembled')).toBe(true);
    });

    it('required 工具缺失 → PlannerCapacityError + capacity.degraded', () => {
        const { bus, events } = makeBus();
        const planner = makePlanner(bus, registryWith([fsReadSpec()]), [provider('a', 1)]);
        const g = goal({
            allowedTools: ['fs.write'],
            metadata: { requiredTools: [{ nameOrCapability: 'fs.write', required: true }] },
        });
        const contract = planner.plan(g).contracts[0];
        const turn = baseTurn(g, contract as TurnContract);
        expect(() => planner.assembleCapacity(turn, g)).toThrow(PlannerCapacityError);
        expect(events.some((e) => e.type === 'capacity.degraded')).toBe(true);
    });
});
