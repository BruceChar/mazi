import { describe, expect, it } from 'vitest';
import { usageViewOf } from '../src/observability/usage-view.js';

describe('usageViewOf（StepUsage 线协议投影）', () => {
    it('null / 非对象 / 空对象 → undefined', () => {
        expect(usageViewOf(undefined)).toBeUndefined();
        expect(usageViewOf(null)).toBeUndefined();
        expect(usageViewOf('x')).toBeUndefined();
        expect(usageViewOf(42)).toBeUndefined();
        expect(usageViewOf({})).toBeUndefined();
    });

    it('仅 vendor 也可投影；非法数值字段被忽略', () => {
        const view = usageViewOf({
            vendor: { inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 'x' },
        });
        expect(view?.vendor?.inputTokens).toBe(10);
        expect(view?.vendor?.outputTokens).toBe(2);
        expect(view?.vendor).not.toHaveProperty('cacheReadInputTokens');
    });

    it('vendor 无任何 token 字段 → 丢弃该段', () => {
        expect(usageViewOf({ vendor: { reportedByVendor: true } })).toBeUndefined();
    });

    it('runtime 段无 totalContextTokens → 丢弃该段', () => {
        expect(usageViewOf({ runtime: { systemPromptTokens: 5 } })).toBeUndefined();
    });

    it('cost 无 totalCostUsd → 丢弃该段；有则补 currency 与缺省成分', () => {
        expect(usageViewOf({ cost: { inputCostUsd: 1 } })).toBeUndefined();
        const view = usageViewOf({ cost: { totalCostUsd: 0.5 } });
        expect(view?.cost?.totalCostUsd).toBe(0.5);
        expect(view?.cost?.currency).toBe('USD');
        expect(view?.cost?.inputCostUsd).toBe(0);
        expect(view?.cost?.cacheWriteCostUsd).toBe(0);
    });

    it('timing 由 totalMs 判定存在性，缺省补 0', () => {
        expect(usageViewOf({ timing: { ttftMs: 3 } })).toBeUndefined();
        expect(usageViewOf({ timing: { totalMs: 9, ttftMs: 3, tokensPerSecond: 1.5 } })?.timing).toEqual(
            { ttftMs: 3, totalMs: 9, tokensPerSecond: 1.5 },
        );
        expect(usageViewOf({ timing: { totalMs: 9 } })?.timing).toEqual({
            ttftMs: 0,
            totalMs: 9,
            tokensPerSecond: 0,
        });
    });

    it('vendor totalTokens = input + output', () => {
        const view = usageViewOf({ vendor: { inputTokens: 30, outputTokens: 12 } });
        expect(view?.vendor?.totalTokens).toBe(42);
    });

    it('runtime 细分段（user/assistant/tool-call）与漂移率投影', () => {
        const view = usageViewOf({
            runtime: {
                totalContextTokens: 1000,
                systemPromptTokens: 400,
                historyTokens: 300,
                historyUserTokens: 100,
                historyAssistantTokens: 150,
                toolCallTokens: 50,
                toolSchemaTokens: 100,
                newInputTokens: 100,
                observationTokens: 100,
                estimationDriftTokens: -50,
                estimationDriftRate: -0.05,
            },
        });
        expect(view?.runtime?.historyUserTokens).toBe(100);
        expect(view?.runtime?.historyAssistantTokens).toBe(150);
        expect(view?.runtime?.toolCallTokens).toBe(50);
        expect(view?.runtime?.estimationDriftTokens).toBe(-50);
        expect(view?.runtime?.estimationDriftRate).toBe(-0.05);
    });

    it('estimate 由 outputTokens 判定存在性；estimatedCost 与 cost 同形', () => {
        expect(usageViewOf({ estimate: { outputDriftTokens: 1 } })).toBeUndefined();
        const view = usageViewOf({
            estimate: { outputTokens: 45, outputDriftTokens: 10, outputDriftRate: 0.28 },
            estimatedCost: { totalCostUsd: 0.0009, priceTierApplied: 'base' },
        });
        expect(view?.estimate?.outputTokens).toBe(45);
        expect(view?.estimate?.outputDriftTokens).toBe(10);
        expect(view?.estimate?.outputDriftRate).toBe(0.28);
        expect(view?.estimatedCost?.totalCostUsd).toBeCloseTo(0.0009, 12);
        expect(view?.estimatedCost?.currency).toBe('USD');
    });

    it('raw 优先：vendor/timing 由原始事实重算，覆盖写入时的派生值', () => {
        const view = usageViewOf({
            raw: {
                providerId: 'deepseek',
                modelId: 'deepseek-flash',
                inputTokens: 150,
                outputTokens: 50,
                cachedInputTokens: 40,
                cachedWriteInputTokens: 10,
                reasoningTokens: 20,
                totalTokens: 200,
                ttftMs: 100,
                totalMs: 300,
            },
            // 写入时算出的派生值若有偏差，raw 优先
            vendor: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
            timing: { ttftMs: 1, totalMs: 1, tokensPerSecond: 1 },
        });
        expect(view?.raw?.providerId).toBe('deepseek');
        expect(view?.vendor?.inputTokens).toBe(150);
        expect(view?.vendor?.outputTokens).toBe(50);
        expect(view?.vendor?.cacheReadInputTokens).toBe(40);
        expect(view?.vendor?.cacheCreationInputTokens).toBe(10);
        expect(view?.vendor?.reasoningOutputTokens).toBe(20);
        expect(view?.vendor?.totalTokens).toBe(200);
        expect(view?.timing?.totalMs).toBe(300);
        expect(view?.timing?.tokensPerSecond).toBeCloseTo((50 / 200) * 1000, 6);
    });

    it('pin 投影：offering / pricingPlan / catalogEpoch', () => {
        const view = usageViewOf({
            raw: { providerId: 'deepseek', modelId: 'm', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            pin: { offeringId: 'deepseek/m', pricingPlanId: 'plan-1', catalogEpoch: 3 },
        });
        expect(view?.pin).toEqual({
            offeringId: 'deepseek/m',
            pricingPlanId: 'plan-1',
            catalogEpoch: 3,
        });
    });

    it('无 raw 时回退写入时的 vendor/timing（旧数据兼容）', () => {
        const view = usageViewOf({
            vendor: { inputTokens: 1, outputTokens: 2 },
            timing: { totalMs: 9, ttftMs: 3 },
        });
        expect(view?.vendor?.inputTokens).toBe(1);
        expect(view?.timing?.totalMs).toBe(9);
        expect(view?.raw).toBeUndefined();
    });

    it('contents / diffContent 投影：仅字符串段，至少一段才输出', () => {
        expect(usageViewOf({ runtime: { totalContextTokens: 1 } })).not.toHaveProperty(
            'runtime.contents',
        );
        const view = usageViewOf({
            runtime: {
                totalContextTokens: 1000,
                contents: { systemPrompt: 'sys', newInput: 'hi', toolCalls: 123 },
                diffContent: 'NEW',
            },
        });
        expect(view?.runtime?.contents?.systemPrompt).toBe('sys');
        expect(view?.runtime?.contents?.newInput).toBe('hi');
        expect(view?.runtime?.contents as Record<string, unknown>).not.toHaveProperty('toolCalls');
        expect(view?.runtime?.diffContent).toBe('NEW');
    });
});
