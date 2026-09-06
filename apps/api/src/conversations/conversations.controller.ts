import 'reflect-metadata';
import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import type { Conversation } from './conversation.js';
import { ConversationsService } from './conversations.service.js';

/** /api/conversations：会话业务抽象列表（普通会话与工作区会话同构） */
@Controller('conversations')
export class ConversationsController {
    constructor(private readonly conversations: ConversationsService) {}

    @Get()
    list(
        @Query('limit') limit?: string,
        @Query('offset') offset?: string,
        @Query('q') q?: string,
    ): Promise<Conversation[]> {
        return this.conversations.list({
            limit: limit === undefined ? undefined : Number.parseInt(limit, 10),
            offset: offset === undefined ? undefined : Number.parseInt(offset, 10),
            q,
        });
    }

    @Patch(':id')
    update(
        @Param('id') conversationId: string,
        @Body() body: Record<string, unknown>,
    ): { ok: boolean } {
        this.conversations.update(conversationId, {
            title: typeof body.title === 'string' ? body.title : undefined,
            archived: typeof body.archived === 'boolean' ? body.archived : undefined,
        });
        return { ok: true };
    }

    @Delete(':id')
    async remove(@Param('id') conversationId: string): Promise<{ ok: boolean }> {
        await this.conversations.remove(conversationId);
        return { ok: true };
    }
}
