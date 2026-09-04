import type {
    Capacity,
    FlagSnapshot,
    LLMDriver,
    LLMRequest,
    LLMResponse,
    LLMStreamEvent,
    Session,
    Step,
    Turn,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { Executor } from '@mazi/executor';
import { SqliteMemoryStore } from '@mazi/memory';
import { PolicyEngineImpl } from '@mazi/policy';
import { ContextMeter, CostCalculator } from '@mazi/usage';
import { describe, expect, it } from 'vitest';
import { SessionResumer } from './recovery';

function stubFlag(): FlagSnapshot {
    return {
        values: {},
        trace: [],
        isEnabled: () => false,
        getNumber: () => undefined,
        getString: () => undefined,
    };
}

function makeSession(turn: Turn): Session {
    return {
        sessionId: turn.sessionId,
        userId: 'u1',
        rawIntent: '读取文件并汇报',
        goal: {
            goalId: ulid(),
            sessionId: turn.sessionId,
            statement: '读取文件并汇报',
            success: { conditions: [], description: '' },
            constraints: [],
            allowedTools: ['fs.read'],
            permissionCeiling: 'read-only',
            budget: { maxSteps: 10, maxCostUsd: 1 },
            termination: { maxSteps: 10 },
            rollbackPolicy: { strategy: 'none' },
            strategyHints: ['complex'],
        },
        strategyId: 'full-loop',
        state: 'running',
        turns: [turn],
        flagSnapshot: stubFlag(),
        createdAt: Date.now(),
    };
}

function makeTurn(capacity: Capacity): Turn {
    return {
        turnId: ulid(),
        sessionId: 'sess-r',
        contract: {
            turnContractId: ulid(),
            parentGoalId: 'g',
            parentPlanNodeId: 'n1',
            statement: '读取文件并汇报',
            tags: ['tools', 'general'],
            success: { conditions: [], description: '' },
            failureSignals: [],
            requiredTools: [{ nameOrCapability: 'fs.read', required: true }],
            maxPermission: 'read-only',
            budget: { maxSteps: 10, maxCostUsd: 1 },
            expectedSideEffects: [],
            rollback: { strategy: 'none' },
            termination: { maxSteps: 10 },
        },
        stepIds: [],
        status: 'running',
        attempt: 1,
        capacity,
    };
}

/** 上下文感知最终驱动：上下文已有工具结果 → 直接返回最终文本 */
class FinalDriver implements LLMDriver {
    calls = 0;
    async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        this.calls++;
        const hasTool = req.context.messages.some((m) => m.role === 'tool');
        if (!hasTool) {
            // 无历史工具结果则再次请求工具（本轮测试不会触发）
            yield {
                type: 'tool-call',
                callId: 'x',
                toolName: 'fs.read',
                arguments: { path: '/tmp/a' },
            };
        } else {
            yield { type: 'text-delta', delta: '恢复后继续完成。' };
        }
        yield {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 8, reportedByVendor: true },
        };
        yield { type: 'end', finishReason: hasTool ? 'stop' : 'tool_calls' };
    }
    async complete(): Promise<LLMResponse> {
        return { content: '' };
    }
}

function capacity(): Capacity {
    return {
        model: { providerId: 'a', vendor: 'test', modelId: 'a-m' },
        tools: [
            {
                name: 'fs.read',
                description: '读文件',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
                minPermission: 'read-only',
                sideEffects: ['fs'],
            },
        ],
        permission: 'read-only',
        budget: { maxSteps: 10, maxCostUsd: 1 },
        sandbox: { enabled: true, network: { allowInternet: false } },
        flags: stubFlag(),
    };
}

describe('recovery（MVP v1.0 §8 F11 / 验收 A9）', () => {
    it('从持久化断点续跑：跳过已完成 Step，工具不重复执行', async () => {
        const mem = new SqliteMemoryStore(':memory:');
        const cap = capacity();
        const turn = makeTurn(cap);
        await mem.saveSession(makeSession(turn));
        await mem.saveTurn(turn);
        // 构造“崩溃前已完成”的现场：thinking + tool_call(fs.read ok) + observation
        const model = cap.model;
        let seq = 0;
        const mk = (kind: Step['kind'], payload: Step['payload']): Step => ({
            stepId: ulid(),
            turnId: turn.turnId,
            sessionId: turn.sessionId,
            seq: seq++,
            kind,
            payload,
            model,
            status: 'ok',
            startedAt: Date.now(),
            endedAt: Date.now(),
        });
        const prior: Step[] = [
            mk('thinking', { content: '计划读取文件' }),
            mk('tool_call', { toolName: 'fs.read', arguments: { path: '/tmp/a' }, callId: 'c1' }),
            mk('observation', { toolName: 'fs.read', content: 'FILE CONTENT' }),
        ];
        for (const s of prior) {
            await mem.saveStep(s);
        }
        await mem.saveCheckpoint(turn.turnId, {
            lastCompletedStepSeq: 2,
            pendingStepIds: [],
            accumulatedUsage: { input: 20, output: 5, cacheWrite: 0, cacheRead: 0, reasoning: 0 },
            accumulatedCostUsd: 0.0001,
            savedAt: Date.now(),
        });
        // 崩溃后重启：新 Executor + 新计数
        let toolInvocations = 0;
        const executor = new Executor({
            driverFor: () => new FinalDriver(),
            fallbackModels: () => [{ model: model }],
            policy: new PolicyEngineImpl({}),
            memory: mem,
            bus: {
                emit: () => undefined,
                subscribe: () => () => undefined,
                replay: () => [],
            } as never,
            tools: {
                invoke: async () => {
                    toolInvocations++;
                    return { ok: true, content: 'FILE CONTENT' };
                },
            },
            meter: new ContextMeter(),
            costs: new CostCalculator(),
            contextWindow: 64000,
            pricing: () => ({
                currency: 'USD',
                base: { inputPerMTok: 1, outputPerMTok: 3 },
                tiers: [],
                effectiveAt: 0,
                version: 'test',
            }),
            systemPrompt: 'sys',
        });
        const resumer = new SessionResumer(mem);
        const resumed = await resumer.resumeRunningTurn(turn.sessionId, executor);
        expect(resumed.outcome?.ok).toBe(true);
        expect(resumed.outcome?.finalMessage).toContain('恢复后继续完成');
        // 已完成工具不重复执行
        expect(toolInvocations).toBe(0);
        const stepsAfter = await mem.listSteps(turn.turnId);
        expect(stepsAfter.length).toBeGreaterThan(3);
        // turn 状态推进为 succeeded 且持久化
        const turns = await mem.listTurns(turn.sessionId);
        expect(turns[0]?.status).toBe('succeeded');
        mem.close();
    });

    it('无 running Turn 时返回空结果', async () => {
        const mem = new SqliteMemoryStore(':memory:');
        const cap = capacity();
        const turn = makeTurn(cap);
        turn.status = 'succeeded';
        await mem.saveSession(makeSession(turn));
        await mem.saveTurn(turn);
        const executor = {} as never;
        const resumer = new SessionResumer(mem);
        const resumed = await resumer.resumeRunningTurn('sess-r', executor);
        expect(resumed.outcome).toBeUndefined();
        mem.close();
    });
});
