import type { StepView } from './types.js';

export interface RenderThinkingChainOptions {
    /** 是否把 invocation（工具调用 + 输出）作为上下文行一并导出（默认 true）。 */
    includeTools?: boolean;
    /** 单条工具输出截断长度（字符，默认 500）。 */
    toolOutputLimit?: number;
}

/**
 * 把一个 Task 的 steps 渲染为可直接复制 / 导出的「thinking 链」文本，供独立审计与缺陷评估。
 *
 * 形态（对齐人工审计时的阅读顺序）：
 * ```text
 * 1. <deliberation[0].thinking>
 *    ↳ shell.run {"command":"ls"} → (空)
 * 2. <deliberation[1].thinking>
 *
 * <最后一个带 answer 的 deliberation 的 answer>
 * ```
 *
 * 规则：
 * - 仅 deliberation 的 thinking 参与编号；无 thinking 的中间轮用其 answer 占位，避免丢失旁白；
 * - 最后一个带 answer 的 deliberation 的 answer 作为最终输出，单独成段，不参与编号；
 * - invocation 以 `↳ tool args → output` 形式作为上下文行，不编号（可用 includeTools=false 关闭）。
 */
export function renderThinkingChain(
    steps: StepView[],
    options: RenderThinkingChainOptions = {},
): string {
    const includeTools = options.includeTools ?? true;
    const toolOutputLimit = options.toolOutputLimit ?? 500;
    const ordered = steps.slice().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

    let finalAnswerIndex = -1;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
        const step = ordered[i];
        if (step?.kind === 'deliberation' && (step.answer ?? '').trim().length > 0) {
            finalAnswerIndex = i;
            break;
        }
    }

    const lines: string[] = [];
    let n = 0;
    let finalAnswer = '';
    ordered.forEach((step, index) => {
        if (step.kind === 'deliberation') {
            const thinking = (step.thinking ?? '').trim();
            const answer = (step.answer ?? '').trim();
            const isFinal = index === finalAnswerIndex;
            const label = thinking.length > 0 ? thinking : isFinal ? '' : answer;
            if (label.length > 0) {
                n += 1;
                lines.push(`${n}. ${label}`);
            }
            if (isFinal) {
                finalAnswer = answer;
            }
            return;
        }
        if (!includeTools) return;
        const args = step.toolArguments ? JSON.stringify(step.toolArguments) : '{}';
        const output = (step.toolOutput ?? '').replace(/\s+/g, ' ').trim();
        const shown =
            output.length > toolOutputLimit ? `${output.slice(0, toolOutputLimit)}…` : output;
        lines.push(
            `   ↳ ${step.toolName ?? 'tool'} ${args} → ${shown.length > 0 ? shown : '(空)'}`,
        );
    });

    const body = lines.join('\n');
    if (finalAnswer.length === 0) return body;
    return body.length > 0 ? `${body}\n\n${finalAnswer}` : finalAnswer;
}
