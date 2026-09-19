import { describe, expect, it } from 'vitest';
import { SETTINGS_TABS } from '../src/scripts/settings-tabs.ts';

describe('settings-tabs（系统设置 IA）', () => {
    it('分类顺序：General / Model / Providers / Auth / About', () => {
        expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
            'general',
            'model',
            'providers',
            'auth',
            'storage',
            'about',
        ]);
    });

    it('Auth 独立成 tab（命令审批规则不再挤占 General）', () => {
        const auth = SETTINGS_TABS.find((tab) => tab.id === 'auth');
        expect(auth?.label).toBe('Auth');
        expect(auth?.icon).toBe('shield');
    });
});
