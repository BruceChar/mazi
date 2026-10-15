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
    /** 页头副标题与 tooltip：这个 tab 在看什么。 */
    hint: string;
}

export const USER_CENTER_TABS: readonly UserCenterTab[] = [
    { id: 'profile', label: '画像', icon: 'user', hint: '本机行为流统计出的机械特征' },
    { id: 'questions', label: '问题', icon: 'search', hint: '历史提问与标签分类' },
    { id: 'behavior', label: '行为链', icon: 'observation', hint: '授权 / 反馈 / 决策等用户行为' },
    { id: 'ledger', label: '账本', icon: 'info', hint: 'vendor 口径的花费记录' },
    { id: 'preferences', label: '用户设置', icon: 'settings', hint: '称呼、偏好与回答风格' },
];

export const DEFAULT_USER_CENTER_TAB: UserCenterTabId = 'profile';

/** 归一化 tab id：未知/缺省值回落到默认 tab（外部或历史值不至于渲染出空白页）。 */
export function userCenterTabOf(id: string | null | undefined): UserCenterTabId {
    return USER_CENTER_TABS.some((tab) => tab.id === id)
        ? (id as UserCenterTabId)
        : DEFAULT_USER_CENTER_TAB;
}
