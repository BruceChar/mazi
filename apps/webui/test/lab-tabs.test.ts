import { describe, expect, it } from 'vitest';
import { isLabTabId, LAB_TABS } from '../src/scripts/lab-tabs.ts';

describe('lab-tabs（Lab 整页导航 IA）', () => {
    it('先 AB 实验，再固定 Benchmark 回归', () => {
        expect(LAB_TABS.map((tab) => tab.id)).toEqual(['ab', 'benchmark']);
    });

    it('Benchmark 使用评测图标，和会话评测区分', () => {
        const benchmark = LAB_TABS.find((tab) => tab.id === 'benchmark');
        expect(benchmark?.label).toBe('Benchmark');
        expect(benchmark?.icon).toBe('observation');
    });

    it('未知分类回退到 AB 实验', () => {
        expect(isLabTabId('ab')).toBe(true);
        expect(isLabTabId('benchmark')).toBe(true);
        expect(isLabTabId('evals')).toBe(false);
    });
});
