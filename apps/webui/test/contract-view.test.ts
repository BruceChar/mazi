import { describe, expect, it } from 'vitest';
import type { ContractTraceView, ContractView, GoalNodeView } from '@mazi/libs';
import {
    acceptanceBadge,
    acceptanceRows,
    contractStateLabel,
    contractStateTone,
    contractSummaryOf,
    contractTraceOf,
    contractsForRun,
    pendingNegotiationOf,
} from '../src/scripts/contract-view.ts';

function contract(over: Partial<ContractView> = {}): ContractView {
    return {
        successConditions: [
            {
                id: 'c1',
                checkType: 'deterministic',
                description: '产出最终回答',
                check: { kind: 'final-answer' },
            },
            { id: 'c2', checkType: 'semantic', description: '回答得体' },
        ],
        failureConditions: [],
        forbiddenResources: [],
        budget: {},
        terminationPolicy: {},
        riskProfile: {
            hasIrreversibleActions: false,
            touchesNetwork: false,
            touchesExternalApi: false,
        },
        deterministicRatio: 0.5,
        ...over,
    };
}

describe('contract-view（契约与验收的展示投影）', () => {
    it('契约摘要：条款文本 + 判定口径 + 占比 + 上限 + 风险 + 禁止项', () => {
        const summary = contractSummaryOf(
            contract({
                budget: { maxCostUsd: 0.5, maxTokens: 1000 },
                terminationPolicy: { maxSteps: 8, timeoutMs: 90_000 },
                forbiddenResources: [{ kind: 'fs-glob', pattern: '/etc/**' }],
                riskProfile: {
                    hasIrreversibleActions: true,
                    touchesNetwork: true,
                    touchesExternalApi: false,
                },
            }),
        );
        expect(summary.conditions.map((row) => row.text)).toEqual(['产出最终回答', '回答得体']);
        expect(summary.conditions.map((row) => row.judgeLabel)).toEqual([
            '机械可判',
            '语义判定',
        ]);
        expect(summary.deterministicPercent).toBe(50);
        expect(summary.limits).toEqual([
            { label: '成本上限', value: '$0.5' },
            { label: '最大轮次', value: '8 轮' },
            { label: 'Token 上限', value: '1000' },
            { label: '超时', value: '90s' },
        ]);
        expect(summary.risks).toEqual(['含不可撤回操作', '触网']);
        expect(summary.forbidden).toEqual(['fs-glob /etc/**']);
        expect(summary.empty).toBe(false);
    });

    it('缺省契约 → 空壳标记；缺 check 的确定性条款 → 尚无检查器', () => {
        const bare = contractSummaryOf();
        expect(bare.empty).toBe(true);
        expect(bare.conditions).toEqual([]);
        expect(bare.deterministicPercent).toBe(0);
        const summary = contractSummaryOf(
            contract({ successConditions: [{ id: 'c9', checkType: 'deterministic' }] }),
        );
        expect(summary.conditions[0]?.judge).toBe('unchecked');
        expect(summary.conditions[0]?.text).toBe('c9');
    });

    it('验收行：条款 id 映射回文本，状态缺省为 unchecked', () => {
        const rows = acceptanceRows(
            { conditions: ['c1', 'c2', 'c3'] },
            contract(),
            {
                checkedAt: 1,
                passed: true,
                evaluated: 1,
                total: 3,
                conditions: [{ conditionId: 'c1', status: 'passed' }],
            },
        );
        expect(rows.map((row) => row.text)).toEqual(['产出最终回答', '回答得体', 'c3']);
        expect(rows.map((row) => row.status)).toEqual(['passed', 'unchecked', 'unchecked']);
    });

    it('契约 Trace：条款判定合并（failed 优先）+ 协商轨迹 + Task 验收', () => {
        const [entry] = contractTraceOf([
            {
                goalId: 'g1',
                status: 'active',
                statement: '批量重命名图片',
                contract: contract({
                    successConditions: [
                        {
                            id: 'c1',
                            checkType: 'deterministic',
                            description: '产出最终回答',
                            check: { kind: 'final-answer' },
                        },
                        { id: 'c2', checkType: 'semantic', description: '命名符合用户预期' },
                    ],
                    failureConditions: [
                        { id: 'f1', checkType: 'semantic', description: '覆盖了非目标文件' },
                    ],
                    terminationPolicy: { maxSteps: 8 },
                    deterministicRatio: 0.5,
                }),
                negotiation: {
                    route: 'negotiate',
                    classifiedBy: 'parser',
                    triggers: ['missing information'],
                    questions: [{ q: '文件在哪？', default: '停止' }],
                    answers: [{ q: '文件在哪？', answer: '在 Downloads' }],
                    revision: 1,
                    resolved: true,
                    at: 5,
                },
                tasks: [
                    {
                        taskId: 't1',
                        status: 'succeeded',
                        title: '批量重命名图片',
                        acceptance: { conditions: ['c1', 'c2'] },
                        acceptanceResult: {
                            checkedAt: 9,
                            passed: true,
                            evaluated: 1,
                            total: 2,
                            conditions: [
                                { conditionId: 'c1', status: 'passed' },
                                { conditionId: 'c2', status: 'unchecked' },
                            ],
                        },
                        steps: [],
                    },
                ],
            },
        ]);
        expect(entry?.negotiation?.revision).toBe(1);
        expect(entry?.conditions.map((row) => row.status)).toEqual(['passed', 'unchecked']);
        expect(entry?.failureConditions).toEqual(['覆盖了非目标文件']);
        expect(entry?.summary.limits).toEqual([{ label: '最大轮次', value: '8 轮' }]);
        expect(entry?.tasks[0]?.acceptance.map((row) => row.status)).toEqual([
            'passed',
            'unchecked',
        ]);
        expect(entry?.tasks[0]?.result?.passed).toBe(true);
    });

    it('形状异常的快照不会抛错（主流程渲染不得因缺字段白屏）', () => {
        expect(contractSummaryOf({} as never).empty).toBe(true);
        expect(contractSummaryOf(null).conditions).toEqual([]);
        expect(
            acceptanceRows({ conditions: undefined } as never, null, {
                conditions: undefined,
            } as never),
        ).toEqual([]);
        expect(acceptanceBadge({ total: 2, passed: true, evaluated: 2 } as never)).toEqual({
            label: '机械验收通过 2/2',
            tone: 'ok',
        });
        const [entry] = contractTraceOf([
            {
                goalId: 'g',
                status: 'active',
                statement: 's',
                contract: {
                    successConditions: undefined,
                    failureConditions: [undefined],
                    forbiddenResources: [undefined],
                    budget: undefined,
                    terminationPolicy: undefined,
                    riskProfile: undefined,
                    deterministicRatio: undefined,
                },
                tasks: [{ taskId: 't', acceptanceResult: { conditions: undefined } }],
            },
        ] as never);
        expect(entry?.conditions).toEqual([]);
        expect(entry?.failureConditions).toEqual(['未命名失败条件']);
        expect(entry?.summary.forbidden).toEqual(['? ']);
        expect(entry?.tasks[0]?.acceptance).toEqual([]);
    });

    it('契约满足度徽标：无条款不谎报满足；色调随状态', () => {
        expect(contractStateLabel(null)).toBe('契约无条款');
        expect(
            contractStateLabel({ state: 'satisfied', total: 2, evaluated: 2, passed: 2, failed: 0 }),
        ).toBe('契约已满足 2/2（已判 2）');
        expect(
            contractStateLabel({ state: 'violated', total: 2, evaluated: 2, passed: 0, failed: 2 }),
        ).toBe('契约未满足 0/2（已判 2）');
        expect(
            contractStateLabel({ state: 'partial', total: 2, evaluated: 1, passed: 1, failed: 0 }),
        ).toBe('部分判定 1/2（已判 1）');
        expect(contractStateTone('satisfied')).toBe('ok');
        expect(contractStateTone('violated')).toBe('fail');
        expect(contractStateTone('partial')).toBe('muted');
        expect(contractStateTone(null)).toBe('muted');
    });

    it('待协商选择：只挑未决且无答复的 negotiate/escalate（可被关掉）', () => {
        const entry = (
            goalId: string,
            negotiation: Record<string, unknown> | null,
        ): Parameters<typeof pendingNegotiationOf>[0] extends readonly (infer T)[] | undefined
            ? T
            : never =>
            ({
                goalId,
                statement: 's',
                goalStatus: 'active',
                negotiation,
                summary: contractSummaryOf(null),
                conditions: [],
                failureConditions: [],
                tasks: [],
            }) as never;

        const pending = entry('g1', {
            route: 'negotiate',
            classifiedBy: 'parser',
            triggers: [],
            questions: [{ q: '文件在哪？', default: '停止' }],
            answers: [],
            revision: 0,
            resolved: false,
            at: 1,
        });
        const answered = entry('g2', {
            route: 'negotiate',
            classifiedBy: 'parser',
            triggers: [],
            questions: [],
            answers: [{ q: 'x', answer: 'y' }],
            revision: 1,
            resolved: true,
            at: 1,
        });
        const fallback = entry('g3', {
            route: 'fallback',
            classifiedBy: 'fallback',
            triggers: [],
            questions: [],
            answers: [],
            revision: 0,
            resolved: true,
            at: 1,
        });
        const escalation = entry('g4', {
            route: 'escalate',
            classifiedBy: 'parser',
            triggers: [],
            questions: [],
            answers: [],
            revision: 0,
            resolved: false,
            at: 1,
            escalation: '请求授权',
        });

        // 取最近的待协商项
        expect(pendingNegotiationOf([fallback, answered, pending])?.goalId).toBe('g1');
        // escalate 也弹（安全/不可调和需要人决）
        expect(pendingNegotiationOf([escalation])?.goalId).toBe('g4');
        // 已关闭的不再弹；已答复/已决的不弹
        expect(pendingNegotiationOf([pending], new Set(['g1']))).toBeNull();
        expect(pendingNegotiationOf([answered, fallback])).toBeNull();
        expect(pendingNegotiationOf(null)).toBeNull();
    });

    it('验收徽标：全判通过 / 有失败 / 部分未判 / 无事实', () => {
        expect(acceptanceBadge(null)).toBeNull();
        expect(
            acceptanceBadge({ checkedAt: 1, passed: true, evaluated: 2, total: 2, conditions: [] }),
        ).toEqual({ label: '机械验收通过 2/2', tone: 'ok' });
        expect(
            acceptanceBadge({
                checkedAt: 1,
                passed: false,
                evaluated: 1,
                total: 2,
                conditions: [{ conditionId: 'c1', status: 'failed' }],
            }),
        ).toEqual({ label: '机械验收未通过（1 条款失败）', tone: 'fail' });
        expect(
            acceptanceBadge({ checkedAt: 1, passed: true, evaluated: 1, total: 2, conditions: [] }),
        ).toEqual({ label: '已判 1/2 · 其余需 judge', tone: 'muted' });
    });

    it('契约 Trace：rootGoalId 逐 Goal 透传（窄栏过滤的依据）', () => {
        const goal = (goalId: string): GoalNodeView => ({
            goalId,
            status: 'active',
            statement: '目标 ' + goalId,
            contract: contract(),
            tasks: [],
        });
        const [entry] = contractTraceOf([goal('g1')], 'root-1');
        expect(entry?.rootGoalId).toBe('root-1');
        // 旧签名（不传 rootGoalId）仍可用：归属未知时留空，展示层兜底全留。
        const [legacy] = contractTraceOf([goal('g1')]);
        expect(legacy?.rootGoalId).toBe('');
    });

    it('契约区范围：窄栏只留当前 run；最大化保留全部 run；归属未知兜底', () => {
        const goal = (goalId: string): GoalNodeView => ({
            goalId,
            status: 'active',
            statement: '目标 ' + goalId,
            contract: contract(),
            tasks: [],
        });
        const run1 = contractTraceOf([goal('g1')], 'r1');
        const run2 = contractTraceOf([goal('g2')], 'r2');
        const all = [...run1, ...run2];

        // 最大化：跨 run 全量对照
        expect(contractsForRun(all, 'r2', true).map((row) => row.goalId)).toEqual(['g1', 'g2']);
        // 窄栏：只留当前选中 Step/Task 所属 run
        expect(contractsForRun(all, 'r2', false).map((row) => row.goalId)).toEqual(['g2']);
        expect(contractsForRun(all, 'r1', false).map((row) => row.goalId)).toEqual(['g1']);
        // 当前 run 未知（旧数据 / 尚未加载）：不隐藏事实
        expect(contractsForRun(all, '', false).map((row) => row.goalId)).toEqual(['g1', 'g2']);
        expect(contractsForRun(all, null, false)).toHaveLength(2);
        expect(contractsForRun(all, undefined, false)).toHaveLength(2);
        expect(contractsForRun(null, 'r1', false)).toEqual([]);

        // 旧数据条目缺 rootGoalId：归属未知，兜底保留
        const legacy: ContractTraceView = { ...(run1[0] as ContractTraceView), rootGoalId: '' };
        expect(contractsForRun([legacy], 'r2', false).map((row) => row.goalId)).toEqual(['g1']);
    });
});
