import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import type { Conversation } from './conversation.js';
import { ConversationsService } from './conversations.service.js';

/** /api/conversations：会话业务抽象列表（普通会话与工作区会话同构） */
@Controller('conversations')
export class ConversationsController {
    constructor(private readonly conversations: ConversationsService) {}

    @Get()
    list(): Promise<Conversation[]> {
        return this.conversations.list();
    }
}
