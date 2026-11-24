import type { PromptPackRegistry } from '../prompts/registry.js';
import type { PromptRiskLevel, PromptTaskKind } from '../prompts/types.js';
import type { SuperAgentDecision, SuperAgentInput } from './types.js';

const SECURITY_WORDS = [
    '删除',
    '发布',
    '支付',
    '转账',
    '生产',
    '权限',
    '外发',
    'deploy',
    'delete',
    'publish',
    'payment',
    'credential',
];
const MEMORY_WORDS = ['上次', '以前', '之前', '继续', '那个项目', '旧项目', '记得', 'previously'];
const DATA_WORDS = ['sql', '数据库', 'schema', '统计', '分析数据', 'dataset', 'analytics'];
const RESEARCH_WORDS = ['调研', '研究', '搜索', '资料', '来源', 'benchmark', 'research'];
const DEBUG_WORDS = ['bug', '失败', '报错', '修复', '测试失败', 'debug', 'fix'];
const CODING_WORDS = [
    '代码',
    '实现',
    '重构',
    '测试',
    '接口',
    '组件',
    '脚本',
    '函数',
    '编程',
    'code',
    'compile',
    'build',
    'script',
    'programming',
];

function containsAny(text: string, words: readonly string[]): boolean {
    return words.some((word) => text.includes(word));
}

/**
 * 任务分类只看用户请求的语义。工具可用性不是任务类型：`shell.run` / `sd` / `git` / `xh`
 * 是通用执行面，任何会话都可能具备，不能据此把所有请求都判成 coding 或 research。
 */
export function classifyTaskKind(
    input: string,
    _tools: readonly string[] = [],
    riskLevel: PromptRiskLevel = 'read-only',
): PromptTaskKind {
    const text = input.toLowerCase();
    if (
        riskLevel === 'external' ||
        riskLevel === 'irreversible' ||
        containsAny(text, SECURITY_WORDS)
    ) {
        return 'security';
    }
    if (containsAny(text, MEMORY_WORDS)) return 'memory';
    if (containsAny(text, DATA_WORDS)) return 'data';
    if (containsAny(text, DEBUG_WORDS)) return 'debug';
    if (containsAny(text, CODING_WORDS)) return 'coding';
    if (containsAny(text, RESEARCH_WORDS)) return 'research';
    return 'general';
}

/**
 * Request-level SuperAgent policy. It is deliberately stateless: durable user
 * and project knowledge belongs to Memory/Blackboard and is passed into it.
 */
export class SuperAgent {
    constructor(private readonly promptPacks: PromptPackRegistry) {}

    decide(input: SuperAgentInput): SuperAgentDecision {
        const tools = input.tools ?? [];
        const riskLevel = input.riskLevel ?? 'read-only';
        const taskKind = input.taskKind ?? classifyTaskKind(input.input, tools, riskLevel);
        const match = this.promptPacks.match(
            {
                ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
                ...(input.projectTags !== undefined ? { projectTags: input.projectTags } : {}),
                ...(input.tools !== undefined ? { tools } : {}),
                ...(input.explicitPackIds !== undefined
                    ? { explicitPackIds: input.explicitPackIds }
                    : {}),
                taskKind,
                input: input.input,
                riskLevel,
            },
            { maxPacks: 2, totalBudgetTokens: 1400 },
        );
        const reason = [
            `task:${taskKind}`,
            `risk:${riskLevel}`,
            ...match.trace.flatMap((trace) =>
                trace.reasons.map((entry) => `${trace.packId}:${entry}`),
            ),
        ];
        return {
            ...(input.userId !== undefined ? { userId: input.userId } : {}),
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
            taskKind,
            riskLevel,
            promptPackIds: match.selected.map((pack) => pack.id),
            plannerId: 'task-graph',
            verifierId: 'independent-default',
            memoryPlan: {
                readUser: input.userId !== undefined,
                readProject: input.projectId !== undefined,
                writeEpisode: true,
            },
            promptMatch: match,
            reason,
        };
    }
}
