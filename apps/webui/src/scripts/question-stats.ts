/**
 * question-stats —— 问题标签分布（纯函数，供画像/问题视图与单测）。
 */
import type { LabelAxis, UserQuestionView } from '@mazi/libs';

export interface LabelCount {
    label: string;
    count: number;
}

/** 按轴统计有效标签分布（count 降序，同 count 按 label 升序）。 */
export function effectiveDistribution(
    questions: readonly UserQuestionView[],
    axis: LabelAxis,
): LabelCount[] {
    const counts = new Map<string, number>();
    for (const question of questions) {
        for (const label of question.effective[axis] ?? []) {
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
