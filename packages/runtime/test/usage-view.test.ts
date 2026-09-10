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
});
