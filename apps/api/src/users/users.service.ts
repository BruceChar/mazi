import 'reflect-metadata';
import type { UserBehaviorView, UserProfileView } from '@mazi/libs';
import { mergeBehaviors, summarizeBehaviors } from '@mazi/libs';
import { Injectable } from '@nestjs/common';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

/**
 * 用户级行为聚合：Conversation（按 userId 过滤）→ runs → 各 run 行为流，按 ts 合并去重。
 * `userId = all` 表示本机全部会话（单用户本地默认）。
 */
@Injectable()
export class UsersService {
    private readonly logger = new Logger('users');

    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly conversations: ConversationsService,
    ) {}

    async behaviors(userId: string): Promise<UserBehaviorView[]> {
        const rootGoalIds = await this.rootGoalIdsOf(userId);
        const groups: UserBehaviorView[][] = [];
        for (const rootGoalId of rootGoalIds) {
            groups.push(await this.runtime.harness().listBehaviors(rootGoalId));
        }
        const merged = mergeBehaviors(...groups);
        this.logger.debug(`behaviors user=${userId} runs=${rootGoalIds.length} → ${merged.length}`);
        return merged;
    }

    async profile(userId: string): Promise<UserProfileView> {
        const behaviors = await this.behaviors(userId);
        return {
            userId,
            behaviorCount: behaviors.length,
            summary: summarizeBehaviors(behaviors),
            generatedAt: Date.now(),
        };
    }

    private async rootGoalIdsOf(userId: string): Promise<string[]> {
        const all = await this.conversations.list();
        const selected = userId === 'all' ? all : all.filter((item) => item.userId === userId);
        return selected.flatMap((conversation) => conversation.runs.map((run) => run.rootGoalId));
    }
}
