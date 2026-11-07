import { describe, expect, it } from 'vitest';
import {
    applyNegotiationAnswers,
    inferWorkspaceStatusIntent,
    parseGoalParserOutput,
    planNegotiation,
} from '../src/gts/negotiation.js';

const confirmedRaw = JSON.stringify({
    trace: { classification: 'command' },
    blocks: [
        {
            route: 'confirmed',
            goals: ['批量重命名 /tmp/photos 下的图片'],
            constraints: ['源目录: /tmp/photos', '模式: IMG_*.jpg -> vacation_*.jpg'],
        },
    ],
});

describe('negotiation（契约协商的机械侧）', () => {
    it('当前项目状态：解析到活动工作区并直接确认广泛汇总，不协商', () => {
        const inferred = inferWorkspaceStatusIntent(
            '项目当前什么状态',
            '/Users/bruce/nodejs/agentwin',
        );
        const plan = planNegotiation(inferred);
        expect(plan.negotiation.route).toBe('confirmed');
        expect(plan.negotiation.questions).toEqual([]);
        expect(plan.negotiation.triggers).toEqual([
            'workspace context resolved',
            'read-only status query',
        ]);
        expect(plan.conditions.map((condition) => condition.description)).toContain(
            '只读调查；除非用户继续要求修改，否则不改变项目。',
        );
        expect(
            inferWorkspaceStatusIntent('部署当前项目', '/Users/bruce/nodejs/agentwin'),
        ).toBeUndefined();
        expect(inferWorkspaceStatusIntent('项目当前什么状态', undefined)).toBeUndefined();
    });

    it('严格解析：合法 JSON → blocks；非 JSON / 未知 route → undefined', () => {
        expect(parseGoalParserOutput(confirmedRaw)?.blocks).toHaveLength(1);
        expect(parseGoalParserOutput('not json')).toBeUndefined();
        expect(parseGoalParserOutput('{"blocks":[]}')).toBeUndefined();
        expect(parseGoalParserOutput('{"blocks":[{"route":"unknown"}]}')).toBeUndefined();
    });

    it('容忍代码块/前后解说包裹的 JSON（真实模型常见输出）', () => {
        const wrapped = ['好的，判断如下：', '```json', confirmedRaw, '```', '以上。'].join('\n');
        const plan = parseGoalParserOutput(wrapped);
        expect(plan?.blocks[0]?.route).toBe('confirmed');
        expect(plan?.blocks[0]?.goals).toHaveLength(1);
        // 只取第一个平衡对象：后面再跟一个 JSON 不干扰
        const two = `${confirmedRaw}\n{"blocks":[{"route":"direct","answer":"x"}]}`;
        expect(parseGoalParserOutput(two)?.blocks[0]?.route).toBe('confirmed');
        // 没有对象 / 截断的 JSON → undefined（走 fallback）
        expect(parseGoalParserOutput('好的，没问题')).toBeUndefined();
        expect(parseGoalParserOutput('{"blocks":[{"route":"confir')).toBeUndefined();
    });

    it('问题形状不全会整条丢弃，且最多保留 2 问', () => {
        const raw = JSON.stringify({
            blocks: [
                {
                    route: 'negotiate',
                    defaultPath: ['停止'],
                    questions: [
                        { q: '文件在哪？', default: '停止' },
                        { q: '缺少默认值' },
                        { q: '第三问', default: 'x' },
                    ],
                },
            ],
        });
        const plan = parseGoalParserOutput(raw);
        expect(plan?.blocks[0]?.questions).toHaveLength(2);
        expect(plan?.blocks[0]?.questions?.[0]?.q).toBe('文件在哪？');
    });

    it('无解析结果 → fallback：默认执行，仅基线机械条款', () => {
        const { negotiation, conditions } = planNegotiation(undefined, () => 7);
        expect(negotiation.route).toBe('fallback');
        expect(negotiation.classifiedBy).toBe('fallback');
        expect(negotiation.triggers).toEqual(['parser-unavailable']);
        expect(negotiation.resolved).toBe(true);
        expect(negotiation.at).toBe(7);
        expect(conditions).toHaveLength(2);
        expect(conditions.every((item) => item.checkType === 'deterministic')).toBe(true);
    });

    it('confirmed → 基线 + goals/constraints 语义条款，已决', () => {
        const plan = planNegotiation(parseGoalParserOutput(confirmedRaw));
        expect(plan.negotiation.route).toBe('confirmed');
        expect(plan.negotiation.classifiedBy).toBe('parser');
        expect(plan.negotiation.resolved).toBe(true);
        // 基线 2 条机械条款 + 1 goal + 2 constraints
        expect(plan.conditions).toHaveLength(5);
        const semantic = plan.conditions.filter((item) => item.checkType === 'semantic');
        expect(semantic.map((item) => item.description)).toEqual([
            '批量重命名 /tmp/photos 下的图片',
            '源目录: /tmp/photos',
            '模式: IMG_*.jpg -> vacation_*.jpg',
        ]);
    });

    it('negotiate → 先冻结 defaultPath，问题待答（未决）', () => {
        const raw = JSON.stringify({
            trace: { triggers: ['missing information'] },
            blocks: [
                {
                    route: 'negotiate',
                    understanding: ['用户以为引用了 100 个文件，会话里没有任何文件'],
                    defaultPath: ['停止；未识别文件集前不重命名'],
                    questions: [{ q: '文件在哪？', why: '没有指称对象', default: '停止' }],
                },
            ],
        });
        const plan = planNegotiation(parseGoalParserOutput(raw));
        expect(plan.negotiation.triggers).toEqual(['missing information']);
        expect(plan.negotiation.resolved).toBe(false);
        expect(plan.negotiation.questions).toHaveLength(1);
        expect(plan.negotiation.defaultPath).toEqual(['停止；未识别文件集前不重命名']);
        expect(plan.conditions[2]?.description).toBe('停止；未识别文件集前不重命名');
    });

    it('direct → 直答且不执行；escalate → 升级待人决', () => {
        const direct = planNegotiation(
            parseGoalParserOutput(
                JSON.stringify({ blocks: [{ route: 'direct', goals: ['答'], answer: '巴黎。' }] }),
            ),
        );
        expect(direct.negotiation.directAnswer).toBe('巴黎。');
        expect(direct.negotiation.resolved).toBe(true);
        expect(direct.conditions).toHaveLength(2);

        const escalate = planNegotiation(
            parseGoalParserOutput(
                JSON.stringify({
                    blocks: [
                        {
                            route: 'escalate',
                            goals: ['删库并保留全部数据'],
                            conflicts: ['互斥'],
                            escalation: '请求上游授权',
                        },
                    ],
                }),
            ),
        );
        expect(escalate.negotiation.escalation).toBe('请求上游授权');
        expect(escalate.negotiation.resolved).toBe(false);
    });

    it('答复：采纳默认不新增条款，手写答复升格为语义条款并修订版本', () => {
        const raw = JSON.stringify({
            blocks: [
                {
                    route: 'negotiate',
                    defaultPath: ['停止'],
                    questions: [
                        { q: '文件在哪？', default: '停止' },
                        { q: '是否覆盖同名？', default: '不覆盖' },
                    ],
                },
            ],
        });
        const plan = planNegotiation(parseGoalParserOutput(raw));
        const applied = applyNegotiationAnswers(
            plan.negotiation,
            [
                { q: '文件在哪？', answer: '', usedDefault: true },
                { q: '是否覆盖同名？', answer: '覆盖并先备份' },
            ],
            plan.conditions,
            () => 9,
        );
        expect(applied.negotiation.resolved).toBe(true);
        expect(applied.negotiation.revision).toBe(1);
        expect(applied.negotiation.at).toBe(9);
        expect(applied.negotiation.answers[0]?.answer).toBe('停止');
        expect(applied.conditions).toHaveLength(plan.conditions.length + 1);
        expect(applied.conditions.at(-1)?.description).toBe('覆盖并先备份');
    });
});
