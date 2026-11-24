import { describe, expect, it } from 'vitest';
import { isLabTabId, LAB_TABS } from '../src/scripts/lab-tabs.ts';

describe('lab-tabs（Lab 整页导航 IA）', () => {
    it('AB 实验在首位，Collections 与 Test Suites 同属 Lab', () => {
        expect(LAB_TABS.map((tab) => tab.id)).toEqual(['ab', 'evals', 'benchmark']);
    });

    it('Collections 用 observation 图标，Test Suites 用 bug 图标', () => {
        const evals = LAB_TABS.find((tab) => tab.id === 'evals');
        const suites = LAB_TABS.find((tab) => tab.id === 'benchmark');
        expect(evals?.label).toBe('Collections');
        expect(evals?.icon).toBe('observation');
        expect(suites?.label).toBe('Test Suites');
        expect(suites?.icon).toBe('bug');
    });

    it('未知分类回退到 AB 实验', () => {
        expect(isLabTabId('ab')).toBe(true);
        expect(isLabTabId('evals')).toBe(true);
        expect(isLabTabId('benchmark')).toBe(true);
        expect(isLabTabId('history')).toBe(false);
    });
});
