import { ProviderError } from '@mazi/core';

/** 归一化 LLM 失败事实（供事件与恢复判断消费）。 */
export function describeLlmError(error: unknown): { code?: string; message: string } {
    if (error instanceof ProviderError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error) {
        return { message: error.message };
    }
    return { message: String(error) };
}

/** 判断是否为「模型名/请求不被接受」类失败（可触发重同步 + 换模重试）。 */
export function isModelRelatedError(described: { code?: string; message: string }): boolean {
    if (described.code === 'invalid_request') return true;
    return /model|模型|unsupported|not found|does not exist/i.test(described.message);
}
