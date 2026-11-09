/**
 * Agent 系统提示注册表：内置默认 + 配置覆盖的唯一事实源。
 *
 * 配置来自 settings.json `prompts` 段（RuntimeConfig.agentPrompts），优先级固定为
 * 配置 > 内置默认；空白值视为未配置，回落到默认。
 */

import { GENERAL_PROMPT } from '../templates/prompts/general.prompt.js';
import { GOAL_PARSER_PROMPT } from '../templates/prompts/goal-parser.prompt.js';
import { TOC_ANALYZE_PROMPT } from '../templates/prompts/toc-analyze.prompt.js';

export const AGENT_PROMPT_IDS = [
    'main',
    'default',
    'coding',
    'planner',
    'executor',
    'reviewer',
    'researcher',
    'intent',
    'replan',
    'iteration-analysis',
] as const;

export type AgentPromptId = (typeof AGENT_PROMPT_IDS)[number];

/** settings.json `prompts` 段的运行时投影：id → 系统提示全文。 */
export type AgentPromptOverrides = Partial<Record<AgentPromptId, string>>;

export const CODING_AGENT_SYSTEM_PROMPT = `你是编码 Agent，在受治理的 mazi runtime 内完成代码类任务。
- 先读相关代码与测试，再做最小修改；不做过早重构。
- 修改后运行最接近的测试或构建命令；失败如实报告，不注释、跳过或删除测试来制造通过。
- 区分根因、兼容风险和未验证假设，不臆测 API 行为。
- 非任务明确要求时不新增依赖；新增依赖必须说明理由与影响面。`;

export const PLANNER_SYSTEM_PROMPT = `你是 Task Planner。把目标拆成边界清晰、可独立验收的 Task，并严格输出 JSON，不输出 Markdown。
每个 Task 是完整工作单元，title 用动词开头；dependsOn 只能引用本次输出中更早的 key；requiredTools 可省略。
不要规划与目标无关的探索，不要重复已完成的工作。`;

export const EXECUTOR_AGENT_SYSTEM_PROMPT =
    '你负责执行已分配的 Task，并报告真实工具结果和验证状态。';

export const REVIEWER_AGENT_SYSTEM_PROMPT =
    '你独立审查结果，优先报告缺陷、风险和未验证项，不修改实现。';

export const RESEARCHER_AGENT_SYSTEM_PROMPT = '你负责调查和证据归纳，区分事实、来源和推断。';

export const REPLAN_SYSTEM_PROMPT = `你是 Replan Planner。某个 Task 未通过验收时，只规划失败补救工作，不重排整个计划。
已完成与尚未执行的 Task 必须保留，不要重复规划；新 Task 必须与原计划边界清晰、互不重叠。
严格输出 JSON，不输出 Markdown。`;

/** 单个 Agent 的定义：id、展示信息与内置默认系统提示。 */
export interface AgentPromptDefinition {
    id: AgentPromptId;
    label: string;
    description: string;
    systemPrompt: string;
}

/** 线协议视图（设置页展示用）。 */
export interface AgentPromptView {
    id: AgentPromptId;
    label: string;
    description: string;
    defaultPrompt: string;
    override?: string;
    effectivePrompt: string;
    source: 'config' | 'default';
}

export const DEFAULT_AGENT_PROMPTS: readonly AgentPromptDefinition[] = [
    {
        id: 'main',
        label: '主 Agent',
        description: '会话执行面的基础系统提示（所有任务共享）',
        systemPrompt: GENERAL_PROMPT,
    },
    {
        id: 'default',
        label: '默认 Agent',
        description: '主 Agent 未配置时的兜底提示，也是 default 委派角色的提示',
        systemPrompt: GENERAL_PROMPT,
    },
    {
        id: 'coding',
        label: '编码 Agent',
        description: '代码类任务追加的执行规范，也是 coding 委派角色的提示',
        systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
    },
    {
        id: 'planner',
        label: '规划 Agent',
        description: 'Task Planner 的拆解规范',
        systemPrompt: PLANNER_SYSTEM_PROMPT,
    },
    {
        id: 'executor',
        label: '执行 Agent',
        description: '执行委派角色的默认提示',
        systemPrompt: EXECUTOR_AGENT_SYSTEM_PROMPT,
    },
    {
        id: 'reviewer',
        label: '审查 Agent',
        description: '独立审查委派角色的默认提示',
        systemPrompt: REVIEWER_AGENT_SYSTEM_PROMPT,
    },
    {
        id: 'researcher',
        label: '研究 Agent',
        description: '调查与证据归纳委派角色的默认提示',
        systemPrompt: RESEARCHER_AGENT_SYSTEM_PROMPT,
    },
    {
        id: 'intent',
        label: '意图解析 Agent',
        description: 'triage 意图识别与路由判定',
        systemPrompt: GOAL_PARSER_PROMPT,
    },
    {
        id: 'replan',
        label: 'Replan Agent',
        description: '失败后补计划的系统提示',
        systemPrompt: REPLAN_SYSTEM_PROMPT,
    },
    {
        id: 'iteration-analysis',
        label: '迭代分析 Agent',
        description: '迭代面板中分析 thinking 链的审计提示',
        systemPrompt: TOC_ANALYZE_PROMPT,
    },
];

const DEFINITIONS = new Map<string, AgentPromptDefinition>(
    DEFAULT_AGENT_PROMPTS.map((definition) => [definition.id, definition]),
);

export function isAgentPromptId(value: string): value is AgentPromptId {
    return DEFINITIONS.has(value);
}

export function agentPromptDefinition(id: AgentPromptId): AgentPromptDefinition {
    const definition = DEFINITIONS.get(id);
    if (definition === undefined) throw new Error(`未知 Agent 提示 id：${id}`);
    return definition;
}

/** 内置默认系统提示（不看配置）。 */
export function defaultAgentPrompt(id: AgentPromptId): string {
    return agentPromptDefinition(id).systemPrompt;
}

function configured(
    overrides: AgentPromptOverrides | undefined,
    id: AgentPromptId,
): string | undefined {
    const value = overrides?.[id];
    if (value === undefined || value.trim().length === 0) return undefined;
    return value;
}

/**
 * 解析某 Agent 生效的系统提示：非空配置优先，否则内置默认。
 * 只读、纯函数，便于调用方在每一轮执行前重新取用。
 */
export function resolveAgentPrompt(id: AgentPromptId, overrides?: AgentPromptOverrides): string {
    return configured(overrides, id) ?? defaultAgentPrompt(id);
}

/**
 * 主执行面的基础提示回退链：main → default → 内置 GENERAL。
 * default 只在 main 未配置时生效，避免两份提示同时拼进上下文。
 */
export function resolveBaseAgentPrompt(overrides?: AgentPromptOverrides): string {
    return (
        configured(overrides, 'main') ??
        configured(overrides, 'default') ??
        defaultAgentPrompt('main')
    );
}

/** 设置页展示用：全部 Agent 的默认值、配置原文与实际生效文本。 */
export function listAgentPromptViews(overrides?: AgentPromptOverrides): AgentPromptView[] {
    return AGENT_PROMPT_IDS.map((id) => {
        const definition = agentPromptDefinition(id);
        const override = configured(overrides, id);
        return {
            id,
            label: definition.label,
            description: definition.description,
            defaultPrompt: definition.systemPrompt,
            ...(override !== undefined ? { override } : {}),
            effectivePrompt: override ?? definition.systemPrompt,
            source: override !== undefined ? 'config' : 'default',
        };
    });
}
