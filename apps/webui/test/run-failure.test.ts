import { describe, expect, it } from 'vitest';
import type { EventItem, FailureLedgerView } from '../src/types.ts';
import { buildRunFailureView } from '../src/scripts/run-failure.ts';

function event(type: string, payload: unknown, timestamp = 1): EventItem {
    return {
        eventId: `${type}-${timestamp}`,
        type,
        rootGoalId: 'run-1',
        timestamp,
        payload,
    } as EventItem;
}

describe('run failure trace view', () => {
    it('汇总 Goal 终态、失败分类账与 Replan 拒绝原因', () => {
        const failures: FailureLedgerView[] = [
            {
                failureId: 'f1',
                sessionId: 'run-1',
                kind: 'budget-exceeded',
                category: 'planning',
                summary: '达到成本上限 $0.125（已花费 $0.1343）',
                createdAt: 3,
            },
        ];
        const view = buildRunFailureView({
            rootGoalId: 'run-1',
            failures,
            events: [
                event(
                    'replan.rejected',
                    { rejected: ['Task t1 需要未注册工具 fs.glob'] },
                    2,
                ),
                event(
                    'goal.ended',
                    {
                        outcome: {
                            status: 'failed',
                            summary: '运行因预算上限终止',
                        },
                    },
                    3,
                ),
            ],
        });

        expect(view?.causes).toEqual([
            '运行因预算上限终止',
            'Task t1 需要未注册工具 fs.glob',
            'budget-exceeded · planning · 达到成本上限 $0.125（已花费 $0.1343）',
        ]);
    });

    it('展示 Replan 自动移除无效工具后的警告', () => {
        const view = buildRunFailureView({
            rootGoalId: 'run-1',
            events: [
                event(
                    'plan.revised',
                    {
                        warnings: ['Task retry 请求未注册工具 fs.glob，已忽略并继续执行'],
                    },
                    2,
                ),
            ],
        });

        expect(view?.warnings).toEqual([
            'Task retry 请求未注册工具 fs.glob，已忽略并继续执行',
        ]);
    });

    it('成功的 run 不生成失败区块', () => {
        const view = buildRunFailureView({
            rootGoalId: 'run-1',
            events: [
                event(
                    'goal.ended',
                    {
                        outcome: { status: 'success', summary: '完成' },
                    },
                    2,
                ),
            ],
        });

        expect(view).toBeNull();
    });
});
