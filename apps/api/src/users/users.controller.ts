import 'reflect-metadata';
import { Controller, Get, Param, Post } from '@nestjs/common';
import { UsersService } from './users.service.js';

/** /api/users/:userId*：用户级行为流、画像与行为数据治理。 */
@Controller('users')
export class UsersController {
    constructor(private readonly users: UsersService) {}

    @Get(':userId/behaviors')
    async behaviors(@Param('userId') userId: string) {
        return { userId, behaviors: await this.users.behaviors(userId) };
    }

    @Get(':userId/behaviors/export')
    exportBehaviors(@Param('userId') userId: string) {
        return this.users.exportBehaviors(userId);
    }

    @Post(':userId/behaviors/backfill')
    backfill(@Param('userId') userId: string) {
        return this.users.backfill(userId);
    }

    @Post(':userId/behaviors/clear')
    clearBehaviors(@Param('userId') userId: string) {
        return this.users.clearBehaviors(userId);
    }

    @Get(':userId/profile')
    profile(@Param('userId') userId: string) {
        return this.users.profile(userId);
    }
}
