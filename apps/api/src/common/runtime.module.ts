import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ApiRuntimeService } from './runtime.service.js';

/** 运行时组合根的模块边界：全局可用、导出供各 feature 注入 */
@Module({
    providers: [ApiRuntimeService],
    exports: [ApiRuntimeService],
})
export class RuntimeModule {}
