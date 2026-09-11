import 'reflect-metadata';
import { Controller, Get, Post } from '@nestjs/common';
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
