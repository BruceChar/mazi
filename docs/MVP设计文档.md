## B.0 MVP 范围定义
MVP 的目标：**用最小代码量验证 v2 的全部核心契约**——三层观测、策略可替换、Provider 适配、Flag 开关——但不追求生产级强度。
### 必做
- L0 契约层完整定义
- `provider-llm` 包：基于 pi-ai 的最小 Driver 实现 + 简单 ProviderPool
- `flags` 包：静态 flag 求值（支持 bucket 分桶）
- `observability` 包：内存事件总线 + 三层 span + JSONL 落盘 sink
- `planner` 最小实现：固定规则路由（capability match → cost 优先）
- `executor` 最小实现：顺序执行 Step，工具白名单校验
- `strategy-plan-execute`（默认策略）+ `strategy-full-loop`（最简版）
- `apps/cli`：本地交互入口
### 不做（明确排除）
- Reflector 独立评估器（MVP 用简单规则替代）
- 沙箱与审批门（仅实现 permission 校验，不真隔离）
- 持久化 Memory（仅内存 + Session 结束时 JSON 落盘）
- OTel 桥接（保留接口，不实现 exporter）
- A/B 实验管理后台（仅手工改 flag 规则文件）
---
## B.1 MVP 包结构
```
harness-mvp/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── packages/
    ├── core/                  # 完整契约（同 A.2）
    ├── provider-llm/
    │   └── src/
    │       ├── driver.ts      # PiAiDriver implements LLMDriver
    │       └── pool.ts        # 简化 ProviderPool（静态注册）
    ├── observability/
    │   └── src/
    │       ├── bus.ts         # InMemoryEventBus
    │       └── sinks/
    │           ├── jsonl.ts   # JSONL 文件 sink
    │           └── console.ts # 控制台 sink
    ├── flags/
    │   └── src/
    │       ├── evaluator.ts   # FlagEvaluator
    │       └── rules.ts       # 从 flags.config.json 加载
    ├── planner/
    │   └── src/
    │       ├── simple-planner.ts
    │       └── router.ts      # 规则路由
    ├── executor/
    │   └── src/
    │       ├── executor.ts
    │       └── tool-registry.ts
    ├── strategies/
    │   └── src/
    │       ├── plan-execute.ts
    │       └── full-loop.ts
    ├── runtime/
    │   └── src/
    │       ├── assemble.ts    # 装配依赖
    │       └── strategy-selector.ts
    └── apps/
        └── cli/
            └── src/main.ts
```
**`pnpm-workspace.yaml`**：
```yaml
packages:
  - 'packages/*'
  - 'packages/apps/*'
```
---
## B.2 MVP 核心实现
### B.2.1 Provider Driver（pi-ai 适配）
```ts
// packages/provider-llm/src/driver.ts
import {
  getModel, stream, complete,
  type Context, type Tool, type Message,
} from '@earendil-works/pi-ai';
import type {
  LLMDriver, LLMRequest, LLMResponse, LLMStreamEvent,
  LLMContext, ToolSpec,
} from '@harness/core';
export class PiAiDriver implements LLMDriver {
  async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const model = getModel(req.model.vendor as any, req.model.modelId as any);
    const ctx = this.toPiContext(req.context);
    const s = stream(model, ctx);
    for await (const ev of s) {
      yield this.mapEvent(ev);
    }
    const final = await s.result();
    yield { type: 'final', message: this.fromPiMessage(final), usage: final.usage };
  }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = getModel(req.model.vendor as any, req.model.modelId as any);
    const res = await complete(model, this.toPiContext(req.context));
    return { message: this.fromPiMessage(res), usage: res.usage };
  }
  private toPiContext(ctx: LLMContext): Context {
    return {
      systemPrompt: ctx.systemPrompt,
      messages: ctx.messages as Message[],
      tools: ctx.tools.map(this.toPiTool),
    };
  }
  private toPiTool(t: ToolSpec): Tool {
    return { name: t.name, description: t.description, parameters: t.parameters as any };
  }
  private mapEvent(ev: any): LLMStreamEvent {
    // pi-ai 事件类型直接透传（thinking_delta / text_delta / toolcall_end / done / error）
    return ev as LLMStreamEvent;
  }
  private fromPiMessage(m: any) { return m; }
}
```
### B.2.2 Provider 池与规则路由
```ts
// packages/provider-llm/src/pool.ts
import type { Provider, ModelRef, ProviderTag } from '@harness/core';
export class ProviderPool {
  private providers = new Map<string, Provider>();
  register(p: Provider) { this.providers.set(p.id, p); }
  /** 简单规则路由：capability 匹配 → costWeight 升序 → 取首个 */
  select(requiredTags: ProviderTag[]): ModelRef | null {
    const candidates = [...this.providers.values()].filter(p =>
      p.health.score > 0.5 &&
      requiredTags.every(tag => p.tags.includes(tag))
    );
    candidates.sort((a, b) => a.costWeight - b.costWeight);
    const chosen = candidates[0];
    if (!chosen) return null;
    const model = chosen.models.find(m => requiredTags.every(tag =>
      (tag === 'tools' && m.supportsTools) ||
      (tag === 'vision' && m.supportsVision) ||
      (tag === 'thinking' && m.supportsThinking) || true
    ));
    return model
      ? { providerId: chosen.id, vendor: chosen.vendor, modelId: model.id }
      : null;
  }
}
```
### B.2.3 Flag 求值器
```ts
// packages/flags/src/evaluator.ts
import type { FeatureFlagDefinition, FlagRule, FlagSnapshot } from '@harness/core';
import { createHash } from 'node:crypto';
export function evaluateFlags(
  defs: FeatureFlagDefinition[],
  ctx: { sessionId: string; userId?: string; goalTags?: string[] }
): FlagSnapshot {
  const values: Record<string, unknown> = {};
  const trace: FlagSnapshot['trace'] = [];
  const bucket = bucketOf(ctx.sessionId); // 0-99
  for (const def of defs) {
    let resolved = def.defaultValue;
    let matched: string | undefined;
    for (const rule of def.rules ?? []) {
      if (matches(rule, ctx, bucket)) {
        resolved = rule.value;
        matched = rule.source;
        break;
      }
    }
    values[def.key] = resolved;
    trace.push({ key: def.key, matchedRule: matched, resolvedValue: resolved });
  }
  return {
    values,
    trace,
    isEnabled: (k) => values[k] === true,
    getNumber: (k) => (typeof values[k] === 'number' ? values[k] as number : undefined),
    getString: (k) => (typeof values[k] === 'string' ? values[k] as string : undefined),
  };
}
function bucketOf(sessionId: string): number {
  const h = createHash('md5').update(sessionId).digest();
  return h[0] % 100;
}
function matches(rule: FlagRule<unknown>, ctx: { userId?: string; goalTags?: string[] }, bucket: number): boolean {
  const m = rule.match ?? {};
  if (m.userIdIn && (!ctx.userId || !m.userIdIn.includes(ctx.userId))) return false;
  if (m.goalTagIn && !(ctx.goalTags ?? []).some(t => m.goalTagIn!.includes(t))) return false;
  if (m.bucketRange && (bucket < m.bucketRange[0] || bucket > m.bucketRange[1])) return false;
  return true;
}
```
### B.2.4 事件总线与 JSONL Sink
```ts
// packages/observability/src/bus.ts
import type { HarnessEvent, EventBus, EventFilter, EventSink } from '@harness/core';
export class InMemoryEventBus implements EventBus {
  private sinks: { filter: EventFilter; sink: EventSink }[] = [];
  private buffer: HarnessEvent[] = [];   // 保留全量，供事后回放
  emit(event: HarnessEvent): void {
    this.buffer.push(event);             // emit 不受 flag 控制
    for (const { filter, sink } of this.sinks) {
      if (this.matches(filter, event)) sink.handle(event);
    }
  }
  subscribe(filter: EventFilter, sink: EventSink) {
    this.sinks.push({ filter, sink });
    return () => {
      this.sinks = this.sinks.filter(s => s.sink !== sink);
    };
  }
  /** 事后回放：按 Session 取全量事件 */
  replay(sessionId: string): HarnessEvent[] {
    return this.buffer.filter(e => e.sessionId === sessionId);
  }
  private matches(f: EventFilter, e: HarnessEvent): boolean {
    if (f.types && !f.types.includes(e.type)) return false;
    if (f.requireFlag && e.attributes['harness.flag_overrides']?.[f.requireFlag.key] !== (f.requireFlag.equals ?? true)) return false;
    return true;
  }
}
```
### B.2.5 Planner 与 Capacity 组装
```ts
// packages/planner/src/simple-planner.ts
import type { Planner, GoalContract, PlanGraph, PlanNode, Capacity, PlanContext, Turn, ProviderTag } from '@harness/core';
import type { ProviderPool } from '@harness/provider-llm';
export class SimplePlanner implements Planner {
  constructor(
    private pool: ProviderPool,
    private toolRegistry: Map<string, ToolSpecLite>,
  ) {}
  async plan(goal: GoalContract, ctx: PlanContext): Promise<PlanGraph> {
    // MVP：按目标 tags 分解为单节点（简单任务）
    const node: PlanNode = {
      nodeId: `node-${ctx.sessionId}-0`,
      title: goal.rawIntent,
      acceptance: goal.success,
      preferredModelTags: goal.tags as ProviderTag[],
    };
    return { sessionId: ctx.sessionId, nodes: [node], edges: [] };
  }
  async assembleCapacity(turn: Turn, ctx: PlanContext): Promise<Capacity> {
    const node = ctx.planGraph.nodes.find(n => n.nodeId === turn.parentPlanNodeId)!;
    const model = this.pool.select(node.preferredModelTags)
      ?? throwNoProvider(node.preferredModelTags);
    // MVP：根据目标 tags 推导工具集
    const tools = [...this.toolRegistry.values()]
      .filter(t => (goalAllows(t, node)));
    const permission = tools.some(t => t.irreversible) ? 'draft' : 'read-only';
    return {
      model,
      tools,
      permission,
      budget: { maxSteps: 20, maxCostUsd: 1.0, timeoutMs: 5 * 60_000 },
      sandbox: { kind: 'inprocess' },          // MVP：无隔离
      flags: ctx.flagSnapshot,
    };
  }
}
```
### B.2.6 Executor
```ts
// packages/executor/src/executor.ts
import type { Executor, Turn, Capacity, Step, HarnessEvent, EventBus } from '@harness/core';
import type { LLMDriver } from '@harness/core';
export class SimpleExecutor implements Executor {
  constructor(
    private driver: LLMDriver,
    private bus: EventBus,
    private toolImpls: Map<string, (args: any) => Promise<any>>,
  ) {}
  async *run(turn: Turn, capacity: Capacity, systemPrompt: string): AsyncIterable<Step> {
    let seq = 0;
    const messages: any[] = [{ role: 'user', content: turn.title }];
    while (seq < (capacity.budget.maxSteps ?? 20)) {
      const stepId = `${turn.turnId}-step-${seq}`;
      const startedAt = Date.now();
      this.emitStep(turn, stepId, seq, 'started');
      const events = this.driver.stream({
        model: capacity.model,
        context: { systemPrompt, messages, tools: capacity.tools as any[] },
      });
      let finalMsg: any;
      for await (const ev of events) {
        if (ev.type === 'final') finalMsg = ev.message;
      }
      const toolCalls = finalMsg.content.filter((b: any) => b.type === 'toolCall');
      // 产出 thinking step
      const thinkStep: Step = {
        stepId, turnId: turn.turnId, sessionId: turn.sessionId,
        seq: seq++, kind: 'thinking',
        payload: { kind: 'thinking', text: extractText(finalMsg) },
        model: capacity.model,
        usage: finalMsg.usage,
        status: 'ok', startedAt, endedAt: Date.now(),
      };
      yield thinkStep;
      if (toolCalls.length === 0) break;
      for (const call of toolCalls) {
        const toolStepId = `${turn.turnId}-step-${seq}`;
        this.emitStep(turn, toolStepId, seq, 'started');
        // 工具白名单 + permission 校验
        const spec = capacity.tools.find(t => t.name === call.name);
        if (!spec || !permissionAllows(spec, capacity.permission)) {
          this.bus.emit({
            eventId: uid(), sessionId: turn.sessionId, turnId: turn.turnId, stepId: toolStepId,
            type: 'tool.blocked', timestamp: Date.now(),
            attributes: { 'harness.step_kind': 'tool_call' },
            payload: { tool: call.name, reason: 'not_allowed' },
          });
          continue;
        }
        const result = await this.toolImpls.get(call.name)!(call.arguments);
        messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
                        content: [{ type: 'text', text: JSON.stringify(result) }], isError: false,
                        timestamp: Date.now() });
        yield {
          stepId: toolStepId, turnId: turn.turnId, sessionId: turn.sessionId,
          seq: seq++, kind: 'tool_call',
          payload: { kind: 'tool_call', name: call.name, args: call.arguments, result },
          status: 'ok', startedAt: Date.now(), endedAt: Date.now(),
        };
      }
      messages.push(finalMsg);
    }
  }
  private emitStep(turn: Turn, stepId: string, seq: number, phase: 'started' | 'ended') {
    this.bus.emit({
      eventId: uid(), sessionId: turn.sessionId, turnId: turn.turnId, stepId,
      type: phase === 'started' ? 'step.started' : 'step.ended',
      timestamp: Date.now(),
      attributes: { 'harness.step_kind': 'thinking' },
    });
  }
}
```
### B.2.7 两个内置策略
```ts
// packages/strategies/src/plan-execute.ts
import type { HarnessStrategy, StrategyContext, StrategyCapabilities } from '@harness/core';
export const planExecuteStrategy: HarnessStrategy = {
  id: 'plan-execute',
  version: '0.1.0',
  capabilities: {
    needsGoal: true, needsPlan: true, needsExecute: true,
    needsObserve: false, needsReflect: false, needsPersistentState: false,
  },
  score: (goal) => (goal.tags.includes('simple') ? 0.9 : 0.4),
  async *run(ctx: StrategyContext) {
    const plan = await ctx.planner!.plan(ctx.session.goal, planCtx(ctx));
    for (const node of plan.nodes) {
      const turn = makeTurn(ctx.session, node);
      const capacity = await ctx.planner!.assembleCapacity(turn, planCtx(ctx));
      for await (const step of ctx.executor!.run(turn, capacity, systemPromptOf(node))) {
        yield { type: 'step', step };
      }
    }
  },
};
```
```ts
// packages/strategies/src/full-loop.ts
export const fullLoopStrategy: HarnessStrategy = {
  id: 'full-loop',
  version: '0.1.0',
  capabilities: {
    needsGoal: true, needsPlan: true, needsExecute: true,
    needsObserve: true, needsReflect: true, needsPersistentState: true,
  },
  score: (goal) => (goal.tags.includes('complex') || goal.tags.includes('long-horizon') ? 0.95 : 0.5),
  async *run(ctx: StrategyContext) {
    const plan = await ctx.planner!.plan(ctx.session.goal, planCtx(ctx));
    for (const node of plan.nodes) {
      const turn = makeTurn(ctx.session, node);
      let attempt = 0;
      while (attempt < 3) {
        const capacity = await ctx.planner!.assembleCapacity(turn, planCtx(ctx));
        const steps: Step[] = [];
        for await (const step of ctx.executor!.run(turn, capacity, systemPromptOf(node))) {
          steps.push(step);
          yield { type: 'step', step };
        }
        // MVP 反思：用规则替代独立评估器
        const verdict = ruleBasedReflect(steps, node.acceptance);
        if (verdict.passed) break;
        // 注入失败信息，重试
        ctx.session.state.lastError = verdict.feedback;
        attempt++;
      }
    }
  },
};
```
### B.2.8 Runtime 装配
```ts
// packages/runtime/src/assemble.ts
export async function bootstrap(config: HarnessConfig) {
  // 1. 实例化基础设施
  const bus = new InMemoryEventBus();
  bus.subscribe({}, new JsonlSink(config.tracePath));      // 全量落盘，永不受 flag 控制
  if (config.flags.isEnabled('console.sink')) {
    bus.subscribe({ minLevel: 'info' }, new ConsoleSink());
  }
  // 2. Provider 池
  const pool = new ProviderPool();
  for (const p of config.providers) pool.register(p);
  const driver = new PiAiDriver();
  // 3. 能力层
  const planner = new SimplePlanner(pool, config.toolRegistry);
  const executor = new SimpleExecutor(driver, bus, config.toolImpls);
  const observer = config.flags.isEnabled('observe.enabled')
    ? new SimpleObserver(bus) : undefined;
  const reflector = config.flags.isEnabled('reflect.enabled')
    ? new RuleReflector() : undefined;
  // 4. 策略选择
  const strategies = [planExecuteStrategy, fullLoopStrategy];
  return { bus, pool, driver, planner, executor, observer, reflector, strategies, flags: config.flags };
}
export async function runSession(input: string, deps: Awaited<ReturnType<typeof bootstrap>>) {
  const sessionId = ulid();
  const flagSnapshot = evaluateFlags(flagDefinitions, { sessionId });
  const goal = await buildGoalContract(input, flagSnapshot);
  const strategy = selectStrategy(deps.strategies, goal);
  const session: Session = {
    sessionId, rawIntent: input, goal,
    strategyId: strategy.id,
    state: { turns: [], lastError: null },
    flagSnapshot, createdAt: Date.now(),
  };
  for await (const ev of strategy.run({
    session,
    planner: strategy.capabilities.needsPlan ? deps.planner : undefined,
    executor: strategy.capabilities.needsExecute ? deps.executor : undefined,
    observer: strategy.capabilities.needsObserve ? deps.observer : undefined,
    reflector: strategy.capabilities.needsReflect ? deps.reflector : undefined,
    memory: new InMemoryMemory(),
    driver: deps.driver,
    flags: flagSnapshot,
    emit: (e) => deps.bus.emit(e),
  })) {
    // CLI 实时渲染
    render(ev);
  }
  deps.bus.emit({
    eventId: ulid(), sessionId, type: 'session.ended', timestamp: Date.now(),
    attributes: { 'harness.strategy_id': strategy.id,
                  'harness.flag_overrides': flagSnapshot.values },
  });
}
```
---
## B.3 MVP 默认 Flag 配置
```json
// flags.config.json
{
  "flags": [
    { "key": "observe.enabled", "type": "boolean", "defaultValue": true },
    { "key": "reflect.enabled", "type": "boolean", "defaultValue": false },
    { "key": "console.sink", "type": "boolean", "defaultValue": true },
    { "key": "memory.persistent", "type": "boolean", "defaultValue": false },
    { "key": "approval.gate", "type": "boolean", "defaultValue": false,
      "rules": [{ "match": { "goalTagIn": ["production"] }, "value": true, "source": "default-prod" }] },
    { "key": "ab.planner.route-v2", "type": "boolean", "defaultValue": false,
      "rules": [
        { "match": { "bucketRange": [0, 49] }, "value": true, "source": "exp-route-v2-2026-09" }
      ] }
  ]
}
```
---
## B.4 MVP 验收标准
| # | 验收项 | 测试方法 |
|---|---|---|
| 1 | 三层 ID 完整 | 打开 JSONL trace 文件，每条事件均含 `sessionId/turnId/stepId`（Session 级事件可缺 turnId/stepId） |
| 2 | 策略切换 | 修改 goal tags 为 `simple` → 自动选择 plan-execute；改为 `complex` → 选择 full-loop |
| 3 | Flag 关闭观测 | 设置 `observe.enabled=false`，确认 Observer 未实例化，但 JSONL trace 仍包含完整 llm.request/tool.invoke |
| 4 | Flag 关闭反思 | 设置 `reflect.enabled=false`，full-loop 退化为简单完成判定，不调用 RuleReflector |
| 5 | A/B 分桶 | 同一 flag 规则下，构造 100 个 sessionId，验证约 50 个落在 v2 bucket |
| 6 | Provider 路由 | 注册两个 Provider（cost 1 / cost 5），目标 tags 不含特殊能力 → 永远选中 cost 1 |
| 7 | 工具白名单 | 尝试调用未注册工具 → 产生 `tool.blocked` 事件且不执行 |
| 8 | 事后回放 | 用 `bus.replay(sessionId)` 离线还原完整决策链 |
| 9 | 契约零依赖 | `packages/core/package.json` 的 dependencies 为空 |
| 10 | pi-ai 隔离 | `grep -r "@earendil-works/pi-ai" packages/ --exclude=provider-llm` 无结果 |
---
## B.5 向 v2 演进的 Roadmap
| 阶段 | 目标 | 关键交付 |
|---|---|---|
| M1（MVP 完成后） | 沙箱与审批 | `policy` 包：PermissionEngine + ApprovalGate + 进程级隔离 |
| M2 | 持久化 Memory | `memory` 包：checkpoint/resume、检索、跨 Session 记忆 |
| M3 | 独立 Reflector | 引入 LLM-as-judge + 校准集，替换 RuleReflector |
| M4 | OTel 桥接 | observability 增加 OTLP exporter，对齐 GenAI semconv |
| M5 | 高级路由 | planner 引入 cost-aware / latency-aware 加权，支持故障转移 |
| M6 | A/B 实验平台 | flags 增加 experiment 管理 API + 自动聚合报表 |
| M7 | 策略生态 | 开放 HarnessStrategy 插件协议，允许第三方包注册策略 |


