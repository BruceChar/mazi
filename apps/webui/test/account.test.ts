import { describe, expect, it } from 'vitest';
import { ACCOUNT_MENU, accountViewOf } from '../src/scripts/account.ts';

describe('account（个人中心菜单 IA）', () => {
    it('菜单含 画像/行为链/账本/用户设置', () => {
        expect(ACCOUNT_MENU.map((item) => item.id)).toEqual([
            'profile',
            'behavior',
            'ledger',
            'preferences',
        ]);
    });

    it('accountViewOf：菜单项映射视图，未知返回 null', () => {
        expect(accountViewOf('profile')).toBe('profile');
        expect(accountViewOf('behavior')).toBe('behavior');
        expect(accountViewOf('ledger')).toBe('ledger');
        expect(accountViewOf('preferences')).toBe('settings');
        expect(accountViewOf('mystery')).toBeNull();
    });
});
