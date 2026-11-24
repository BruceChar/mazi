/**
 * Lab 全屏工作区的左侧分类导航。
 * Lab 与设置页一致：整页接管，左侧导航 + 底部返回主菜单。
 */
export interface LabTab {
    id: 'ab' | 'benchmark';
    label: string;
    icon: string;
}

export const LAB_TABS: readonly LabTab[] = [
    { id: 'ab', label: 'AB 实验', icon: 'hammer' },
    { id: 'benchmark', label: 'Benchmark', icon: 'observation' },
];

export function isLabTabId(value: unknown): value is LabTab['id'] {
    return LAB_TABS.some((tab) => tab.id === value);
}
