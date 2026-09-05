import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
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
            providers: overview.providers,
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
}
