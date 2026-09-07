import type { ObservationContext, ObservationPayload, Observer } from '@mazi/core';

/** 模型回注上下文的最大长度；超过则保留头尾 */
export const OBSERVATION_CONTEXT_LIMIT = 4_000;

/** 截取用于模型上下文的观察内容：超长保留头部与尾部，避免污染窗口 */
export function compactContextText(content: string, limit = OBSERVATION_CONTEXT_LIMIT): string {
    if (content.length <= limit) {
        return content;
    }
    const head = content.slice(0, Math.floor(limit * 0.7));
    const tail = content.slice(-Math.floor(limit * 0.3));
    return `${head}\n…[已截断，共 ${content.length} 字符]…\n${tail}`;
}

/** 把工具执行结果转换为结构化 ObservationPayload */
export function observationPayloadFor(ctx: ObservationContext): ObservationPayload {
    if (ctx.result.ok) {
        const content = ctx.result.content;
        return {
            toolName: ctx.toolName,
            content,
            contextContent: compactContextText(content),
            structured: {
                ok: true,
                toolName: ctx.toolName,
                length: content.length,
                truncated: content.length > OBSERVATION_CONTEXT_LIMIT,
            },
        };
    }
    return {
        toolName: ctx.toolName,
        content: ctx.result.error,
        isError: true,
        contextContent: ctx.result.error,
        structured: {
            ok: false,
            toolName: ctx.toolName,
            retryable: ctx.result.retryable ?? false,
        },
    };
}

/** 默认 Observer：结构化工具观察；上层可通过实现 core Observer 替换 */
export class DefaultObserver implements Observer {
    observeToolResult(ctx: ObservationContext): Promise<ObservationPayload> {
        return Promise.resolve(observationPayloadFor(ctx));
    }
}
