/**
 * account.ts —— 个人中心菜单与视图映射（docs/webui.md §3.2）。
 * 纯常量 + 纯函数，供 TopBar / App 与单测共用，避免 IA 规则散落在模板里。
 */

export type AccountMenuId = 'profile' | 'questions' | 'behavior' | 'ledger' | 'preferences';
/** 个人中心菜单可跳转的视图（preferences 复用既有个人设置视图 'settings'）。 */
export type AccountView = 'profile' | 'questions' | 'behavior' | 'ledger' | 'settings';

export interface AccountMenuItem {
    id: AccountMenuId;
    label: string;
    icon: string;
}

export const ACCOUNT_MENU: readonly AccountMenuItem[] = [
    { id: 'profile', label: '画像', icon: 'user' },
    { id: 'questions', label: '问题', icon: 'search' },
    { id: 'behavior', label: '行为链', icon: 'observation' },
    { id: 'ledger', label: '账本', icon: 'info' },
    { id: 'preferences', label: '用户设置', icon: 'settings' },
];

/** 菜单项 → 视图；未知 id 返回 null（调用方保持当前视图）。 */
export function accountViewOf(id: string): AccountView | null {
    if (id === 'profile') return 'profile';
    if (id === 'questions') return 'questions';
    if (id === 'behavior') return 'behavior';
    if (id === 'ledger') return 'ledger';
    if (id === 'preferences') return 'settings';
    return null;
}
