import 'reflect-metadata';
import type { SystemVersionView } from '@mazi/libs';
import { Controller, Get } from '@nestjs/common';
import { SystemService } from './system.service.js';

/** /api/system：面板「系统」页的版本与构建信息（只读，永不失败）。 */
@Controller('system')
export class SystemController {
    constructor(private readonly system: SystemService) {}

    @Get('info')
    info(): SystemVersionView {
        return this.system.info();
    }
}
