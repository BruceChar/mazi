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
});
