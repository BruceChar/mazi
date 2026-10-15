import { describe, expect, it } from 'vitest';
import {
    DEFAULT_USER_CENTER_TAB,
    USER_CENTER_TABS,
    userCenterTabOf,
} from '../src/scripts/user-center.ts';

describe('user-center（用户中心 tab IA）', () => {
    it('tab 顺序为 画像/问题/行为链/账本/用户设置', () => {
        expect(USER_CENTER_TABS.map((tab) => tab.id)).toEqual([
            'profile',
            'questions',
            'behavior',
            'ledger',
            'preferences',
        ]);
    });

    it('每个 tab 都有文案与图标', () => {
        for (const tab of USER_CENTER_TABS) {
            expect(tab.label.length).toBeGreaterThan(0);
            expect(tab.icon.length).toBeGreaterThan(0);
        }
    });

    it('默认 tab 是画像', () => {
        expect(DEFAULT_USER_CENTER_TAB).toBe('profile');
        expect(USER_CENTER_TABS[0].id).toBe(DEFAULT_USER_CENTER_TAB);
    });

    it('userCenterTabOf：已知 id 原样返回', () => {
        for (const tab of USER_CENTER_TABS) {
            expect(userCenterTabOf(tab.id)).toBe(tab.id);
        }
    });

    it('userCenterTabOf：未知 / 空值回落到默认 tab', () => {
        expect(userCenterTabOf('mystery')).toBe(DEFAULT_USER_CENTER_TAB);
        expect(userCenterTabOf('')).toBe(DEFAULT_USER_CENTER_TAB);
        expect(userCenterTabOf(null)).toBe(DEFAULT_USER_CENTER_TAB);
        expect(userCenterTabOf(undefined)).toBe(DEFAULT_USER_CENTER_TAB);
    });
});
