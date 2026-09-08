import 'reflect-metadata';
import type { GoalRunResult, GoalTreeSnapshot } from '@mazi/runtime';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** GoalsService：Goal 会话运行与快照查询（core Goal/Task/Step 坐标系，C4b） */
@Injectable()
export class GoalsService {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** POST /api/goals：运行一次 Goal 会话（create+execute+snapshot） */
    async run(body: Record<string, unknown>): Promise<{
        rootGoalId: string;
        result: GoalRunResult;
        snapshot: GoalTreeSnapshot;
    }> {
        const input = typeof body.input === 'string' ? body.input : '';
        if (!input.trim()) {
            throw new BadRequestException('input 必填');
        }
        return this.runtime.harness().runGoalSession(input);
    }

    /** GET /api/goals/:rootGoalId：Goal 树四元组快照 */
    async snapshot(rootGoalId: string): Promise<GoalTreeSnapshot> {
        return this.runtime.harness().goalSnapshot(rootGoalId);
    }
}
