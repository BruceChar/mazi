/**
 * deterministic-finalize —— 确定性输出的单轮收尾。
 *
 * 模型可在同一条回复里给出最终答案模板与工具调用（模板用 {{result}} / {{result:N}}
 * 标记工具结果落点）。当本轮所有工具都成功且占位符都能被结果填满时，harness 直接
 * 渲染模板作为最终输出，不再发起下一轮 LLM 请求。
 */

export const RESULT_PLACEHOLDER = '{{result}}';

const PLACEHOLDER_PATTERN = /\{\{\s*result(?::([^}]+))?\s*\}\}/g;

export interface FinalizeResult {
    callId: string;
    toolName: string;
    output: string;
    isError: boolean;
}

export interface RenderedTemplate {
    text: string;
    /** 未能解析的占位符原文；非空表示不可收尾。 */
    unresolved: string[];
}

export function hasResultPlaceholder(template: string): boolean {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    return PLACEHOLDER_PATTERN.test(template);
}

function resolvePlaceholder(
    selector: string | undefined,
    results: readonly FinalizeResult[],
): string | undefined {
    if (results.length === 0) return undefined;
    if (selector === undefined || selector.trim() === '') {
        return results.map((result) => result.output).join('\n\n');
    }
    const key = selector.trim();
    if (/^\d+$/.test(key)) {
        return results[Number(key) - 1]?.output;
    }
    const byName = results.filter((result) => result.toolName === key);
    if (byName.length === 0) return undefined;
    return byName.map((result) => result.output).join('\n\n');
}

export function renderResultTemplate(
    template: string,
    results: readonly FinalizeResult[],
): RenderedTemplate {
    const unresolved: string[] = [];
    PLACEHOLDER_PATTERN.lastIndex = 0;
    const text = template.replace(PLACEHOLDER_PATTERN, (match, selector: string | undefined) => {
        const value = resolvePlaceholder(selector, results);
        if (value === undefined) {
            unresolved.push(match);
            return match;
        }
        return value;
    });
    return { text, unresolved };
}

export interface FinalizeDecision {
    finalMessage: string;
}

/**
 * 判定本轮是否可确定性收尾。任一条件不满足返回 undefined，交回正常多轮循环：
 * 模板无占位符 / 结果为空 / 有失败 / 存在无法解析的占位符。
 */
export function decideFinalize(
    template: string,
    results: readonly FinalizeResult[],
): FinalizeDecision | undefined {
    if (!hasResultPlaceholder(template)) return undefined;
    if (results.length === 0) return undefined;
    if (results.some((result) => result.isError)) return undefined;
    const rendered = renderResultTemplate(template, results);
    if (rendered.unresolved.length > 0) return undefined;
    return { finalMessage: rendered.text };
}
