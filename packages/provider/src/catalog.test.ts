import { describe, expect, it } from 'vitest';
import { builtinModelsFor, builtinVendors } from './catalog.js';

describe('builtinModelsFor（pi-ai 目录读取）', () => {
    it('deepseek 目录返回模型元数据', () => {
        expect(builtinVendors()).toContain('deepseek');
        const models = builtinModelsFor('deepseek');
        expect(models.length).toBeGreaterThan(0);
        expect(
            models.every(
                (model) => model.id.length > 0 && (model.capabilities.maxInputTokens ?? 0) > 0,
            ),
        ).toBe(true);
        expect(models[0]?.pricing?.inputPerMTok).toBeGreaterThan(0);
        // 目录补充：厂商新模型即使 pi-ai 目录未收录也可用
        expect(models.some((model) => model.id === 'deepseek-v41-flash')).toBe(true);
    });

    it('未知厂商 / 空厂商 → 空数组（不抛错）', () => {
        expect(builtinModelsFor('not-a-vendor')).toEqual([]);
        expect(builtinModelsFor('')).toEqual([]);
    });
});
