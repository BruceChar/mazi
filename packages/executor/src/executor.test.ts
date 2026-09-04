import type {
    Capacity,
    EventBus,
    FlagSnapshot,
    HarnessEvent,
    LLMDriver,
    LLMRequest,
    LLMResponse,
    LLMStreamEvent,
    MemoryStore,
    ModelRef,
    Session,
    Step,
    ToolExecutionResult,
    ToolSpec,
    Turn,
    TurnCheckpoint,
    UserInteractionRecord,
} from '@mazi/core';
import { ulid } from '@mazi/core';
import { PolicyEngineImpl } from '@mazi/policy';
import { ContextMeter, CostCalculator } from '@mazi/usage';
import { describe, expect, it } from 'vitest';
import { Executor } from './executor';

function stubFlag(): FlagSnapshot {
    return {
        values: {},
        trace: [],
        isEnabled: () => false,
        getNumber: () => undefined,
        getString: () => undefined,
    };
}

function fsSpec(): ToolSpec {
    return {
        name: 'fs.read',
        description: '读文件',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: ['fs'],
    };
}

class MemoryStub implements MemoryStore {
    sessions = new Map<string, Session>();
    turns = new Map<string, Turn>();
    turnList = new Map<string, Turn[]>();
    steps = new Map<string, Step[]>();
    checkpoints = new Map<string, TurnCheckpoint>();
    records = new Map<string, UserInteractionRecord>();

    async saveSession(s: Session): Promise<void> {
        this.sessions.set(s.sessionId, structuredClone(s));
    }
    async loadSession(id: string): Promise<Session | undefined> {
        return structuredClone(this.sessions.get(id));
    }
    async saveTurn(t: Turn): Promise<void> {
        this.turns.set(t.turnId, structuredClone(t));
        const list = this.turnList.get(t.sessionId) ?? [];
        const idx = list.findIndex((x) => x.turnId === t.turnId);
        if (idx >= 0) {
            list[idx] = structuredClone(t);
        } else {
            list.push(structuredClone(t));
        }
        this.turnList.set(t.sessionId, list);
    }
    async listTurns(sessionId: string): Promise<Turn[]> {
        return structuredClone(this.turnList.get(sessionId) ?? []);
    }
    async saveStep(step: Step): Promise<void> {
        const list = this.steps.get(step.turnId) ?? [];
        const idx = list.findIndex((x) => x.stepId === step.stepId);
        if (idx >= 0) {
            list[idx] = structuredClone(step);
        } else {
            list.push(structuredClone(step));
        }
        this.steps.set(step.turnId, list);
    }
    async listSteps(turnId: string): Promise<Step[]> {
        return structuredClone(this.steps.get(turnId) ?? []).sort((a, b) => a.seq - b.seq);
    }
    async saveCheckpoint(turnId: string, cp: TurnCheckpoint): Promise<void> {
        this.checkpoints.set(turnId, structuredClone(cp));
    }
    async loadCheckpoint(turnId: string): Promise<TurnCheckpoint | undefined> {
        return structuredClone(this.checkpoints.get(turnId));
    }
    async saveUserInteractionRecord(r: UserInteractionRecord): Promise<void> {
        this.records.set(r.recordId, structuredClone(r));
    }
    async loadUserInteractionRecord(id: string): Promise<UserInteractionRecord | undefined> {
        return structuredClone(this.records.get(id));
    }
    async loadUserInteractionBySession(
        sessionId: string,
    ): Promise<UserInteractionRecord | undefined> {
        for (const r of this.records.values()) {
            if (r.sessionId === sessionId) {
                return structuredClone(r);
            }
        }
        return undefined;
    }
    async listUserInteractionRecords(opts?: {
        userId?: string;
        status?: 'recording' | 'completed';
        limit?: number;
    }): Promise<UserInteractionRecord[]> {
        let all = [...this.records.values()].filter(
            (r) =>
                (opts?.userId ? r.userId === opts.userId : true) &&
                (opts?.status ? r.status === opts.status : true),
        );
        all = all.sort((a, b) => b.updatedAt - a.updatedAt);
        if (opts?.limit) {
            all = all.slice(0, opts.limit);
        }
        return structuredClone(all);
    }
}

function busStub(): { bus: EventBus; events: HarnessEvent[] } {
    const events: HarnessEvent[] = [];
    const bus = {
        emit: (e: HarnessEvent) => void events.push(e),
        subscribe: () => () => undefined,
        replay: () => [] as HarnessEvent[],
    } as unknown as EventBus;
    return { bus, events };
}

function capacity(over: Partial<Capacity> = {}): Capacity {
    return {
        model: { providerId: 'a', vendor: 'test', modelId: 'a-m' },
        tools: [fsSpec()],
        permission: 'read-only',
        budget: { maxSteps: 10, maxCostUsd: 1 },
        sandbox: { enabled: true, network: { allowInternet: false } },
        flags: stubFlag(),
        ...over,
    };
}

/** 上下文感知测试驱动：上下文含 tool 结果则返回最终文本，否则返回 fs.read tool-call */
class SmartDriver implements LLMDriver {
    calls = 0;
    constructor(private readonly failCalls = 0) {}
    async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        this.calls++;
        if (this.calls <= this.failCalls) {
            throw new Error('scripted-fail');
        }
        const hasToolResult = req.context.messages.some((m) => m.role === 'tool');
        const events: LLMStreamEvent[] = [];
        if (hasToolResult) {
            events.push({ type: 'text-delta', delta: '已读取并完成任务。' });
        } else {
            events.push({
                type: 'tool-call',
                callId: 'c1',
                toolName: 'fs.read',
                arguments: { path: '/tmp/a.txt' },
            });
        }
        events.push({
            type: 'usage',
            usage: { inputTokens: 60, outputTokens: 20, reportedByVendor: true },
        });
        events.push({ type: 'end', finishReason: hasToolResult ? 'stop' : 'tool_calls' });
        for (const e of events) {
            yield e;
        }
    }
    async complete(_req: LLMRequest): Promise<LLMResponse> {
        return {
            content: 'complete',
            usage: { inputTokens: 1, outputTokens: 1, reportedByVendor: false },
        };
    }
}

function makeTurn(): Turn {
    return {
        turnId: ulid(),
        sessionId: 'sess-e',
        contract: {
            turnContractId: ulid(),
            parentGoalId: 'g',
            parentPlanNodeId: 'n1',
            statement: '读取 /tmp/a.txt 并汇报',
            tags: ['tools', 'general'],
            success: { conditions: [], description: '' },
            failureSignals: [{ kind: 'tool-error', action: 'retry', maxRetries: 1 }],
            requiredTools: [{ nameOrCapability: 'fs.read', required: true }],
            maxPermission: 'read-only',
            budget: { maxSteps: 10, maxCostUsd: 1 },
            expectedSideEffects: [],
            rollback: { strategy: 'none' },
            termination: { maxSteps: 10 },
        },
        stepIds: [],
        status: 'pending',
        attempt: 1,
    };
}

function pricing() {
    return {
        currency: 'USD' as const,
        base: { inputPerMTok: 1, outputPerMTok: 3 },
        tiers: [],
        effectiveAt: 0,
        version: 'test',
    };
}

const modelA: ModelRef = { providerId: 'a', vendor: 'test', modelId: 'a-m' };
const modelB: ModelRef = { providerId: 'b', vendor: 'test', modelId: 'b-m' };

function baseDeps(over: Record<string, unknown> = {}) {
    return {
        driverFor: () => {
            throw new Error('no driver');
        },
        fallbackModels: () => [{ model: modelA }],
        policy: new PolicyEngineImpl({}),
        memory: new MemoryStub(),
        bus: busStub().bus,
        tools: { invoke: async () => ({ ok: true, content: '' }) },
        meter: new ContextMeter(),
        costs: new CostCalculator(),
        contextWindow: 64000,
        pricing: () => pricing(),
        systemPrompt: 'sys',
        promptVersion: '0.1.0',
        ...over,
    };
}

describe('Executor（MVP v1.0 §8 F10）', () => {
    it('完整工具闭环：tool_call→工具→观察→最终回答，usage/事件/checkpoint/持久化齐备', async () => {
        const { bus, events } = busStub();
        const mem = new MemoryStub();
        const invocations: string[] = [];
        const driver = new SmartDriver();
        const executor = new Executor(
            baseDeps({
                driverFor: (providerId: string) => {
                    if (providerId === 'a') return driver;
                    throw new Error('no driver');
                },
                fallbackModels: () => [{ model: modelA }],
                memory: mem,
                bus,
                tools: {
                    invoke: async (name: string) => {
                        invocations.push(name);
                        return { ok: true, content: 'FILE CONTENT' };
                    },
                },
            }),
        );
        const outcome = await executor.executeTurn(makeTurn(), capacity());
        expect(outcome.ok).toBe(true);
        expect(outcome.reason).toBe('final-answer');
        expect(outcome.finalMessage).toContain('已读取');
        expect(invocations).toEqual(['fs.read']);
        expect(outcome.steps.length).toBeGreaterThanOrEqual(4);
        const llmSteps = outcome.steps.filter((s) => s.usage !== undefined);
        expect(llmSteps.length).toBeGreaterThanOrEqual(2);
        for (const s of llmSteps) {
            expect(s.usage?.vendor.reportedByVendor).toBe(true);
            expect(s.usage?.cost.pricingVersion).toBe('test');
            expect(typeof s.usage?.runtime.totalContextTokens).toBe('number');
        }
        expect(outcome.accumulatedCostUsd).toBeGreaterThan(0);
        expect(outcome.accumulatedTokens.input).toBeGreaterThan(0);
        expect(mem.checkpoints.size).toBeGreaterThan(0);
        const saved = await mem.listTurns('sess-e');
        expect(saved[0]?.status).toBe('succeeded');
        for (const type of [
            'llm.request',
            'llm.response',
            'tool.invoke',
            'tool.result',
            'step.started',
            'step.ended',
        ]) {
            expect(events.some((e) => e.type === type)).toBe(true);
        }
    });

    it('Policy 拦截：白名单外工具被 blocked，工具不执行', async () => {
        const { bus } = busStub();
        const mem = new MemoryStub();
        let invoked = false;
        class EvilDriver implements LLMDriver {
            async *stream(): AsyncIterable<LLMStreamEvent> {
                yield { type: 'tool-call', callId: 'x', toolName: 'fs.write', arguments: {} };
                yield {
                    type: 'usage',
                    usage: { inputTokens: 1, outputTokens: 1, reportedByVendor: true },
                };
                yield { type: 'end', finishReason: 'tool_calls' };
            }
            async complete(): Promise<LLMResponse> {
                return { content: '' };
            }
        }
        const executor = new Executor(
            baseDeps({
                driverFor: () => new EvilDriver(),
                memory: mem,
                bus,
                tools: {
                    invoke: async () => {
                        invoked = true;
                        return { ok: true, content: '' };
                    },
                },
            }),
        );
        const outcome = await executor.executeTurn(makeTurn(), capacity());
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('blocked-tool');
        expect(outcome.error?.code).toBe('tool-blocked');
        expect(invoked).toBe(false);
        expect(outcome.steps.some((s) => s.status === 'blocked')).toBe(true);
    });

    it('Provider 故障转移：首选失败自动切次优并 emit provider.fallback', async () => {
        const { bus, events } = busStub();
        const mem = new MemoryStub();
        const driverB = new SmartDriver();
        const executor = new Executor(
            baseDeps({
                driverFor: (providerId: string) => {
                    if (providerId === 'b') return driverB;
                    throw new Error('scripted-fail-a');
                },
                fallbackModels: () => [{ model: modelA }, { model: modelB }],
                memory: mem,
                bus,
                tools: {
                    invoke: async () => ({ ok: true, content: 'OK' }),
                },
            }),
        );
        const cap = capacity();
        const outcome = await executor.executeTurn(makeTurn(), cap);
        expect(outcome.ok).toBe(true);
        expect(cap.model.providerId).toBe('b');
        expect(events.some((e) => e.type === 'provider.fallback')).toBe(true);
    });

    it('预算 maxSteps 封顶：持续 tool-call 场景 → max-steps', async () => {
        const { bus } = busStub();
        const mem = new MemoryStub();
        class LoopDriver implements LLMDriver {
            async *stream(): AsyncIterable<LLMStreamEvent> {
                yield {
                    type: 'tool-call',
                    callId: 'c',
                    toolName: 'fs.read',
                    arguments: { path: '/tmp/x' },
                };
                yield {
                    type: 'usage',
                    usage: { inputTokens: 1, outputTokens: 1, reportedByVendor: true },
                };
                yield { type: 'end', finishReason: 'tool_calls' };
            }
            async complete(): Promise<LLMResponse> {
                return { content: '' };
            }
        }
        const executor = new Executor(
            baseDeps({
                driverFor: () => new LoopDriver(),
                memory: mem,
                bus,
            }),
        );
        const outcome = await executor.executeTurn(
            makeTurn(),
            capacity({ budget: { maxSteps: 2 } }),
        );
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('max-steps');
    });

    it('断点续跑：上下文含已完成工具结果时不再重复执行工具（A9 语义）', async () => {
        const { bus } = busStub();
        const mem = new MemoryStub();
        let invocations = 0;
        const driver = new SmartDriver();
        const executor = new Executor(
            baseDeps({
                driverFor: () => driver,
                memory: mem,
                bus,
                tools: {
                    invoke: async () => {
                        invocations++;
                        return { ok: true, content: 'FILE CONTENT' };
                    },
                },
            }),
        );
        const cap = capacity();
        const turn = makeTurn();
        const first = await executor.executeTurn(turn, cap);
        expect(first.ok).toBe(true);
        const invAfterFirst = invocations;
        const second = await executor.executeTurn(turn, cap);
        expect(second.ok).toBe(true);
        expect(invocations).toBe(invAfterFirst);
        expect(second.steps.length).toBeGreaterThanOrEqual(first.steps.length);
    });

    it('全部候选 Driver 失败 → driver-error（retryable）', async () => {
        const { bus } = busStub();
        const mem = new MemoryStub();
        const executor = new Executor(
            baseDeps({
                driverFor: () => {
                    throw new Error('boom');
                },
                memory: mem,
                bus,
            }),
        );
        const outcome = await executor.executeTurn(makeTurn(), capacity());
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('driver-error');
        expect(outcome.error?.retryable).toBe(true);
        expect(outcome.steps).toHaveLength(0);
    });
});
