import { describe, expect, it } from 'vitest';
import { isLabTabId, LAB_TABS } from '../src/scripts/lab-tabs.ts';

describe('lab-tabs（Lab 整页导航 IA）', () => {
    it('AB 实验在首位，线上评测与固定 Benchmark 同属 Lab', () => {
        expect(LAB_TABS.map((tab) => tab.id)).toEqual(['ab', 'evals', 'benchmark']);
    });

    it('评测从侧栏平级入口收进 Lab，图标与 AB 区分', () => {
        const evals = LAB_TABS.find((tab) => tab.id === 'evals');
        expect(evals?.label).toBe('线上评测');
        expect(evals?.icon).toBe('observation');
    });

    it('未知分类回退到 AB 实验', () => {
        expect(isLabTabId('ab')).toBe(true);
        expect(isLabTabId('evals')).toBe(true);
        expect(isLabTabId('benchmark')).toBe(true);
        expect(isLabTabId('history')).toBe(false);
    });
});
