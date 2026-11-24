/**
 * 关联实验的历史上下文（docs/AB测试设计.md §7）。
 *
 * 「从某一次实验继续」在数据上等价于：把那次实验的「输入 + 指定臂最终答案」
 * 折成一对历史轮次，作为**两臂共用**的 `RunOptions.history` 注入。
 * 两臂看到完全相同的历史，控制变量（模型/技能/开关）才是唯一差异。
 */
import type { ExperimentView } from '@mazi/core';
import type { ConversationTurn } from '../harness/conversation.js';

/** 历史答案的最大字符数；超长答案截断，避免把下一次实验的上下文预算吃光。 */
export const CONTEXT_ANSWER_LIMIT_CHARS = 4000;

/** 关联臂缺省取该实验第一个有最终答案的臂（如 A 臂失败、B 臂成功）。 */
function contextArmOf(view: ExperimentView, armLabel: string | undefined) {
    if (armLabel !== undefined) return view.arms.find((arm) => arm.label === armLabel);
    return view.arms.find((arm) => answerOf(arm.metrics?.finalAnswer).length > 0);
}

function answerOf(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 关联实验 → 历史轮次。
 *
 * 该臂没有最终答案（未跑完 / 失败）时返回 undefined —— 此时宁可给出干净上下文，
 * 也不要用「空答案」假冒一次历史，否则两臂都会从一句空话开始。
 */
export function contextHistoryOf(
    view: ExperimentView,
    armLabel?: string,
): ConversationTurn[] | undefined {
    const arm = contextArmOf(view, armLabel);
    const answer = answerOf(arm?.metrics?.finalAnswer);
    if (answer.length === 0) return undefined;
    const text =
        answer.length > CONTEXT_ANSWER_LIMIT_CHARS
            ? answer.slice(0, CONTEXT_ANSWER_LIMIT_CHARS) + '…（历史答案已截断）'
            : answer;
    const input = view.input.trim();
    return input.length === 0
        ? [{ role: 'assistant', text }]
        : [
              { role: 'user', text: input },
              { role: 'assistant', text },
          ];
}
