import 'reflect-metadata';
import { Controller, Get, Param } from '@nestjs/common';
import type { UserProfile } from './users.service.js';
import { UsersService } from './users.service.js';

/** GET /api/users/:userId/profile */
@Controller('users')
export class UsersController {
    constructor(private readonly users: UsersService) {}

    @Get(':userId/profile')
    profile(@Param('userId') userId: string): Promise<UserProfile> {
        return this.users.profile(userId);
    }
}
