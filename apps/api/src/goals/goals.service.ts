import 'reflect-metadata';
import type { GoalRunResult, GoalTreeSnapshot } from '@mazi/runtime';
import { BadRequestException, Injectable } from '@nestjs/common';
import Logger from '../common/log.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** GoalsService：Goal 会话运行与快照查询（core Goal/Task/Step 坐标系，C4b） */
@Injectable()
export class GoalsService {
    private readonly logger = new Logger('goals');

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
        this.logger.log(`run input=${JSON.stringify(input.slice(0, 80))}`);
        const result = await this.runtime.harness().runGoalSession(input);
        this.logger.log(`run done rootGoalId=${result.rootGoalId} ok=${result.result.ok}`);
        return result;
    }

    /** GET /api/goals/:rootGoalId：Goal 树四元组快照 */
    async snapshot(rootGoalId: string): Promise<GoalTreeSnapshot> {
        const snapshot = await this.runtime.harness().goalSnapshot(rootGoalId);
        this.logger.debug(
            `snapshot rootGoalId=${rootGoalId} goals=${snapshot.goals.length} tasks=${snapshot.taskCount} steps=${snapshot.stepCount}`,
        );
        return snapshot;
    }
}
