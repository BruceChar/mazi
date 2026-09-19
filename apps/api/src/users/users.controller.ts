import 'reflect-metadata';
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { type QuestionFilterQuery, UsersService } from './users.service.js';

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

    @Get(':userId/profile')
    profile(@Param('userId') userId: string) {
        return this.users.profile(userId);
    }

    @Get(':userId/questions')
    async questions(@Param('userId') userId: string, @Query() query: Record<string, string>) {
        return {
            userId,
            questions: await this.users.questions(userId, parseQuestionFilter(query)),
        };
    }
}

/** query string → QuestionFilterQuery（数字字段严格解析，非法忽略）。 */
function parseQuestionFilter(query: Record<string, string>): QuestionFilterQuery {
    const num = (value: string | undefined): number | undefined =>
        value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
    return {
        ...(query.type ? { type: query.type } : {}),
        ...(query.domain ? { domain: query.domain } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.topic ? { topic: query.topic } : {}),
        ...(query.q ? { q: query.q } : {}),
        ...(num(query.from) !== undefined ? { from: num(query.from) } : {}),
        ...(num(query.to) !== undefined ? { to: num(query.to) } : {}),
        ...(num(query.limit) !== undefined ? { limit: num(query.limit) } : {}),
    };
}
