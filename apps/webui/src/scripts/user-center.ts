/**
 * user-center.ts —— 用户中心（User Center）的信息架构：tab 清单与归一化。
 * 纯常量 + 纯函数，供 UserCenterPage / App 与单测共用，避免 IA 规则散落在模板里。
 */

/** 用户中心的 tab：画像 / 问题 / 行为链 / 账本 / 用户设置。 */
export type UserCenterTabId = 'profile' | 'questions' | 'behavior' | 'ledger' | 'preferences';

export interface UserCenterTab {
    id: UserCenterTabId;
    label: string;
    icon: string;
}

export const USER_CENTER_TABS: readonly UserCenterTab[] = [
    { id: 'profile', label: '画像', icon: 'user' },
    { id: 'questions', label: '问题', icon: 'search' },
    { id: 'behavior', label: '行为链', icon: 'observation' },
    { id: 'ledger', label: '账本', icon: 'info' },
    { id: 'preferences', label: '用户设置', icon: 'settings' },
];

export const DEFAULT_USER_CENTER_TAB: UserCenterTabId = 'profile';

/** 归一化 tab id：未知/缺省值回落到默认 tab（外部或历史值不至于渲染出空白页）。 */
export function userCenterTabOf(id: string | null | undefined): UserCenterTabId {
    return USER_CENTER_TABS.some((tab) => tab.id === id)
        ? (id as UserCenterTabId)
        : DEFAULT_USER_CENTER_TAB;
}
