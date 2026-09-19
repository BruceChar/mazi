import 'reflect-metadata';
import type {
    GoalRunRef,
    UserBehaviorExportView,
    UserBehaviorView,
    UserProfileView,
    UserQuestionView,
} from '@mazi/libs';
import { mergeBehaviors, summarizeBehaviors } from '@mazi/libs';
import { Injectable } from '@nestjs/common';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';

const BEHAVIOR_STREAM_SCHEMA = '2.0';

/** 问题查询过滤（`type` 即言说类型 speech_act）。 */
export interface QuestionFilterQuery {
    type?: string;
    domain?: string;
    category?: string;
    topic?: string;
    q?: string;
    from?: number;
    to?: number;
    limit?: number;
}

/**
 * 用户级行为聚合与治理：Conversation（按 userId 过滤）→ runs → 各 run 行为流。
 * `userId = all` 表示本机全部会话（单用户本地默认）。
 * 画像本期只做机械特征简单统计；导出/回填/清除供 Settings → Storage 使用。
 */
@Injectable()
export class UsersService {
    private readonly logger = new Logger('users');

    constructor(
        private readonly runtime: ApiRuntimeService,
        private readonly conversations: ConversationsService,
    ) {}

    async behaviors(userId: string): Promise<UserBehaviorView[]> {
        const runs = await this.runsOf(userId);
        const groups: UserBehaviorView[][] = [];
        for (const run of runs) {
            groups.push(await this.runtime.harness().listBehaviors(run.rootGoalId));
        }
        const merged = mergeBehaviors(...groups);
        this.logger.debug(`behaviors user=${userId} runs=${runs.length} → ${merged.length}`);
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

    /** 导出为存储格式（文件头 + 记录；doc §6 存储即导出）。 */
    async exportBehaviors(userId: string): Promise<UserBehaviorExportView> {
        return {
            format: 'user-behavior-stream',
            schemaVersion: BEHAVIOR_STREAM_SCHEMA,
            subject: { id: userId },
            behaviors: await this.behaviors(userId),
        };
    }

    /**
     * 历史提问回填：为采集上线前、行为流为空的 run 写入一条 derived `input`。
     * 只补提问；历史反馈/授权从未采集，不臆造。返回回填的 run 数。
     */
    async backfill(userId: string): Promise<{ backfilled: number }> {
        const runs = await this.runsOf(userId);
        let backfilled = 0;
        for (const run of runs) {
            const stored = await this.runtime.harness().listBehaviors(run.rootGoalId);
            if (stored.length > 0) continue;
            await this.runtime.harness().backfillBehaviorInput(run.rootGoalId, {
                input: run.input,
                createdAt: run.createdAt,
            });
            backfilled += 1;
        }
        this.logger.log(`backfill user=${userId} runs=${runs.length} → ${backfilled}`);
        return { backfilled };
    }

    /** 清除该用户行为流（治理删除）；返回清除的 run 数。 */
    async clearBehaviors(userId: string): Promise<{ cleared: number }> {
        const runs = await this.runsOf(userId);
        for (const run of runs) {
            await this.runtime.harness().clearBehaviors(run.rootGoalId);
        }
        this.logger.log(`clearBehaviors user=${userId} runs=${runs.length}`);
        return { cleared: runs.length };
    }

    /**
     * 用户问题查询：runtime 取问题视图（含有效标签），再按轴/全文过滤。
     * `type` 即言说类型（speech_act）。
     */
    async questions(userId: string, filter: QuestionFilterQuery = {}): Promise<UserQuestionView[]> {
        const views = await this.runtime.harness().listQuestions({
            ...(userId !== 'all' ? { userId } : {}),
            ...(filter.from !== undefined ? { from: filter.from } : {}),
            ...(filter.to !== undefined ? { to: filter.to } : {}),
            ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
        });
        const key = filter.q?.trim().toLowerCase();
        return views.filter((view) => {
            const effective = view.effective;
            if (filter.type && !(effective.speech_act ?? []).includes(filter.type)) return false;
            if (filter.domain && !(effective.domain ?? []).includes(filter.domain)) return false;
            if (filter.category && !(effective.category ?? []).includes(filter.category))
                return false;
            if (filter.topic && !(effective.topic ?? []).includes(filter.topic)) return false;
            if (key && key.length > 0 && !view.text.toLowerCase().includes(key)) return false;
            return true;
        });
    }

    private async runsOf(userId: string): Promise<GoalRunRef[]> {
        const all = await this.conversations.list();
        const selected = userId === 'all' ? all : all.filter((item) => item.userId === userId);
        return selected.flatMap((conversation) => conversation.runs);
    }
}
