/** triage 超时上限：协商是增强能力，绝不能拖住创建会话（进而拖住主会话输出）。 */
export const TRIAGE_TIMEOUT_MS = 10_000;

/** 给 promise 加超时；超时或失败都返回 undefined（调用方回落 fallback，不抛错）。 */
export function withTriageTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
        );
    });
}
