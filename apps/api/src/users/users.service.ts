import 'reflect-metadata';
import type { UserInteractionRecord } from '@mazi/core';
import { Injectable } from '@nestjs/common';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** GET /api/users/:userId/profile 聚合快照（契约对齐旧实现字段） */
export interface UserProfile {
    userId: string;
    sessions: number;
    totalCostUsd: number;
    totalTokens: number;
    avgRating?: number;
    outcomes: Record<string, number>;
    recent: Array<{
        sessionId: string;
        input: string;
        outcome?: string;
        updatedAt?: number;
        costUsd?: number;
    }>;
}

/** UsersService：用户交互记录聚合（只读投影） */
@Injectable()
export class UsersService {
    constructor(private readonly runtime: ApiRuntimeService) {}

    async profile(userId: string): Promise<UserProfile> {
        const records = (await this.runtime
            .harness()
            .store.listUserInteractionRecords({ userId })) as UserInteractionRecord[];
        const cost = records.reduce((acc, r) => acc + (r.metrics.totalCostUsd ?? 0), 0);
        const tokens = records.reduce((acc, r) => acc + (r.metrics.totalTokens ?? 0), 0);
        const ratings = records.flatMap((r) =>
            r.feedback
                .filter((f) => f.type === 'output_rating' && typeof f.rating === 'number')
                .map((f) => f.rating as number),
        );
        const outcomes: Record<string, number> = {};
        for (const r of records) {
            const key = r.outcome?.status ?? 'recording';
            outcomes[key] = (outcomes[key] ?? 0) + 1;
        }
        return {
            userId,
            sessions: records.length,
            totalCostUsd: cost,
            totalTokens: tokens,
            avgRating: ratings.length
                ? ratings.reduce((a, b) => a + b, 0) / ratings.length
                : undefined,
            outcomes,
            recent: records.slice(0, 20).map((r) => ({
                sessionId: r.sessionId,
                input: r.rawInput.slice(0, 80),
                outcome: r.outcome?.status,
                updatedAt: r.updatedAt,
                costUsd: r.metrics.totalCostUsd,
            })),
        };
    }
}
