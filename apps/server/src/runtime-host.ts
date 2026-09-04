import type { RunResult, RuntimeConfig } from '@mazi/harness-runtime';
import { HarnessRuntime as RT } from '@mazi/harness-runtime';

/**
 * 运行主机（MVP）：单 runtime 实例 + busy 互斥。
 * 设计 §2 L-App RunService 的同步版；多会话并发/队列为后续（SSE 实时）特性。
 */
export class RuntimeHost {
    private runtime?: RT;
    private busy = false;

    constructor(private readonly buildConfig: () => RuntimeConfig) {}

    getRuntime(): RT {
        if (!this.runtime) {
            this.runtime = new RT(this.buildConfig());
        }
        return this.runtime;
    }

    isBusy(): boolean {
        return this.busy;
    }

    /** 同步执行（复用 HarnessRuntime.run），busy 时抛 409 语义错误 */
    async run(input: string, userId?: string): Promise<RunResult> {
        if (this.busy) {
            const error = new Error('已有任务在运行，请稍候');
            (error as Error & { status?: number }).status = 409;
            throw error;
        }
        this.busy = true;
        try {
            return await this.getRuntime().run(input, { userId });
        } finally {
            this.busy = false;
        }
    }

    async close(): Promise<void> {
        if (this.runtime) {
            await this.runtime.close().catch(() => undefined);
        }
    }
}
