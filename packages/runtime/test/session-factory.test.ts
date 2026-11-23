import { describe, expect, it } from 'vitest';
import { DefaultEventBus } from '../src/events/event-bus.js';
import { SessionFactory } from '../src/harness/session-factory.js';
import { SessionIntake } from '../src/harness/session-intake.js';
import { MemoryBlackboardStore, ProjectBlackboardService } from '../src/blackboard/index.js';
import { MemoryGoalStore } from '../src/memory/goal-store.js';
import { MemoryBehaviorStore } from '../src/memory/behavior-store.js';
import { MemoryManager } from '../src/memory/memory.js';
import { BehaviorRecorder } from '../src/observability/behavior-recorder.js';
import type { ModelResolver } from '../src/harness/model-resolver.js';
import type { RoundRunner } from '../src/harness/round-runner.js';
import type { RuntimeConfig } from '../src/config.js';

function buildFactory(): {
    factory: SessionFactory;
    intake: SessionIntake;
    goalStore: MemoryGoalStore;
    events: Array<{ type: string }>;
} {
    const intake = new SessionIntake();
    const goalStore = new MemoryGoalStore();
    const events: Array<{ type: string }> = [];
    const bus = new DefaultEventBus();
    bus.subscribe(
        {},
        {
            id: 'capture',
            handle: (event) => {
                events.push(event as unknown as { type: string });
            },
        },
    );
    const factory = new SessionFactory({
        intake,
        sessionIds: new Map(),
        beginSession: async () => {},
        config: { providers: [], tools: [] } as unknown as RuntimeConfig,
        blackboard: new ProjectBlackboardService(new MemoryBlackboardStore()),
        memoryManager: new MemoryManager(),
        goalStoreDb: goalStore,
        behaviorRecorder: new BehaviorRecorder(new MemoryBehaviorStore()),
        labelQuestion: async () => {},
        bus,
        resolver: {
            defaultModelChoice: () => undefined,
            resolveModelChoice: () => undefined,
        } as ModelResolver,
        roundRunner: {} as RoundRunner,
        intentPrompt: () => 'intent',
    });
    return { factory, intake, goalStore, events };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SessionFactory', () => {
    it('freshContext=true：不建黑板注入，memoryContext 标记 fresh', async () => {
        const { factory, intake } = buildFactory();
        const fresh = await factory.create('调研一个话题', {
            workspaceRoot: '/tmp/mazi-fresh-workspace',
            freshContext: true,
        });
        expect(intake.pendingBlackboard.has(fresh.rootGoalId)).toBe(false);
        expect(intake.pendingMemoryContext.get(fresh.rootGoalId)?.fresh).toBe(true);

        const carried = await factory.create('调研一个话题', {
            workspaceRoot: '/tmp/mazi-carry-workspace',
        });
        expect(intake.pendingBlackboard.get(carried.rootGoalId)).toMatchObject({
            workspace: '/tmp/mazi-carry-workspace',
        });
        expect(intake.pendingMemoryContext.get(carried.rootGoalId)?.fresh).toBeUndefined();
    });

    it('创建会话立即落库并冻结契约，运行级输入先进 intake', async () => {
        const { factory, intake, goalStore } = buildFactory();
        const ids = await factory.create('把首页改成深色', {
            userId: 'u1',
            conversationId: 'c1',
            permissionCeiling: 'workspace-write',
            maxSteps: 5,
            maxCostUsd: 1.5,
            promptFragment: '只改样式',
            skillIds: ['frontend'],
            allowedTools: ['fs.read'],
            delegationDepth: 1,
        });
        const goal = await goalStore.loadGoal(ids.rootGoalId);
        expect(goal?.statement).toBe('把首页改成深色');
        expect(goal?.permissionCeiling).toBe('workspace-write');
        expect(goal?.contract.terminationPolicy).toEqual({ maxSteps: 5 });
        expect(goal?.contract.budget).toEqual({ maxCostUsd: 1.5 });
        expect(goal?.contract.successConditions.length).toBeGreaterThan(0);

        expect(intake.pendingPromptFragment.get(ids.rootGoalId)).toBe('只改样式');
        expect(intake.pendingSkills.get(ids.rootGoalId)).toEqual(['frontend']);
        expect(intake.pendingAllowedTools.get(ids.rootGoalId)).toEqual(['fs.read']);
        expect(intake.pendingDelegationDepth.get(ids.rootGoalId)).toBe(1);
        expect(intake.pendingSessionId.get(ids.rootGoalId)).toBe('c1');
    });

    it('默认不跑 triage；开启但无可用模型时静默回落，不写协商结论', async () => {
        const { factory, intake, goalStore } = buildFactory();
        const ids = await factory.create('看看仓库状态', { parseIntent: true });
        const pending = intake.pendingTriage.get(ids.rootGoalId);
        expect(pending).toBeDefined();
        await pending;
        const goal = await goalStore.loadGoal(ids.rootGoalId);
        expect(goal?.negotiation).toBeUndefined();

        const { factory: idle } = buildFactory();
        const second = await idle.create('再来一次');
        await sleep(0);
        expect(intake.pendingTriage.has(second.rootGoalId)).toBe(false);
    });
});
