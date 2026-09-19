import 'reflect-metadata';
import { Controller, Get, Param } from '@nestjs/common';
import { UsersService } from './users.service.js';

/** /api/users/:userId*：用户级行为流与画像（简单统计）。 */
@Controller('users')
export class UsersController {
    constructor(private readonly users: UsersService) {}

    @Get(':userId/behaviors')
    async behaviors(@Param('userId') userId: string) {
        return { userId, behaviors: await this.users.behaviors(userId) };
    }

    @Get(':userId/profile')
    profile(@Param('userId') userId: string) {
        return this.users.profile(userId);
    }
}
