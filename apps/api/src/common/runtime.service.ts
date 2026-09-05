import 'reflect-metadata';
import type { MaziPaths, RuntimeConfig } from '@mazi/harness-runtime';
import {
    configOverview,
    ensureMaziDirs,
    HarnessRuntime,
    loadRuntimeConfig,
    toRuntimeConfig,
} from '@mazi/harness-runtime';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ApiError } from './api-error.js';

/**
 * ApiRuntimeService：API 侧组合根（docs/后端与存储设计.md v0.2 §10.2）。
 * 惰性装配 {@link HarnessRuntime}（领域/存储零改动），持有与旧实现一致的进程内串行执行锁，
 * 并在应用停机时关闭运行时。依赖单向：controller/service → 本服务 → @mazi/harness-runtime。
 */
@Injectable()
export class ApiRuntimeService implements OnApplicationShutdown {
    private runtime: HarnessRuntime | undefined;
    private running = false;
    private readonly paths: MaziPaths = ensureMaziDirs();
    private readonly config: RuntimeConfig = toRuntimeConfig(loadRuntimeConfig(this.paths.home), {
        consoleEnabled: false,
    });

    /** MAZI_HOME 目录树（health/config 展示用） */
    get homePaths(): MaziPaths {
        return this.paths;
    }

    /** 是否正有会话在执行（串行锁状态） */
    get isRunning(): boolean {
        return this.running;
    }

    /** 首次调用时装配 HarnessRuntime 并复用 */
    harness(): HarnessRuntime {
        if (!this.runtime) {
            this.runtime = new HarnessRuntime(this.config);
        }
        return this.runtime;
    }

    /** 配置总览（configOverview 同源） */
    overview(): { home: string; providers: string[]; hasProvidersFile: boolean } {
        return configOverview();
    }

    /** 与旧实现一致的进程内串行锁：已有会话执行时 → 409 */
    async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.running) {
            throw new ApiError(409, '已有会话在运行，请稍候');
        }
        this.running = true;
        try {
            return await operation();
        } finally {
            this.running = false;
        }
    }

    async onApplicationShutdown(): Promise<void> {
        await this.runtime?.close();
    }
}
