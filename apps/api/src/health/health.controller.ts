import 'reflect-metadata';
import { Controller, Get, Post, Query } from '@nestjs/common';
import { recentLogs } from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** /api/health 与 /api/config：契约对齐旧 node:http 实现（docs v0.2 §10.4） */
@Controller()
export class HealthController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get('health')
    health(): Record<string, unknown> {
        const overview = this.runtime.overview();
        const paths = this.runtime.homePaths;
        return {
            ok: true,
            busy: this.runtime.isRunning,
            storage: { driver: 'sqlite', home: paths.home, db: paths.dbPath },
            providers: overview.providers.map((p) => p.id),
        };
    }

    @Get('config')
    config(): Record<string, unknown> {
        const overview = this.runtime.overview();
        const paths = this.runtime.homePaths;
        return {
            ...overview,
            defaultConfigDir: paths.home,
            storage: { driver: 'sqlite', db: paths.dbPath, events: paths.eventDir },
        };
    }

    /** GET /api/logs?level=&limit=：进程内系统日志（错误/告警/信息），供 UI「日志/事件」。 */
    @Get('logs')
    logs(
        @Query('level') level?: string,
        @Query('limit') limit?: string,
    ): { logs: ReturnType<typeof recentLogs> } {
        const all = recentLogs();
        const filtered =
            level && level !== 'all' ? all.filter((entry) => entry.level === level) : all;
        const parsed = Number(limit);
        const logs = Number.isFinite(parsed) && parsed > 0 ? filtered.slice(-parsed) : filtered;
        return { logs };
    }

    /** POST /api/runtime/restart：在线重同步端点模型并重建运行时（进程内重启语义）。 */
    @Post('runtime/restart')
    async restart(): Promise<Record<string, unknown>> {
        return this.runtime.restart();
    }

    /** POST /api/config/sync：在线发现端点模型并返回最新配置。 */
    @Post('config/sync')
    async syncConfig(): Promise<Record<string, unknown>> {
        const overview = await this.runtime.syncConfig();
        const paths = this.runtime.homePaths;
        return {
            ...overview,
            defaultConfigDir: paths.home,
            storage: { driver: 'sqlite', db: paths.dbPath, events: paths.eventDir },
        };
    }
}
