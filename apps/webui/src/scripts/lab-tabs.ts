/**
 * Lab 全屏工作区的左侧分类导航。
 * Lab 与设置页一致：整页接管，左侧导航 + 底部「Back to app」返回入口。
 *
 * 线上评测（真实 Trace 派生）与固定 Benchmark（离线回归）收进同一个 Lab，
 * 避免用户在两个平级入口之间来回找；AB 实验的历史列表挂在 AB 分类下面。
 */
export interface LabTab {
    id: 'ab' | 'evals' | 'benchmark';
    label: string;
    icon: string;
    /** 分类说明，展示在内容区标题旁。 */
    hint: string;
}

export const LAB_TABS: readonly LabTab[] = [
    { id: 'ab', label: 'AB 实验', icon: 'hammer', hint: '两臂对照执行，比较同一任务的差异' },
    {
        id: 'evals',
        label: '线上评测',
        icon: 'observation',
        hint: '真实会话 Trace 自动派生，观察线上表现',
    },
    {
        id: 'benchmark',
        label: 'Benchmark',
        icon: 'bug',
        hint: '固定任务集回归，校验模型或 Prompt 改动',
    },
];

export function isLabTabId(value: unknown): value is LabTab['id'] {
    return LAB_TABS.some((tab) => tab.id === value);
}
