import type { LLMMessage, LLMProvider, PermissionLevel } from '@mazi/core';
import type { PlannedTask } from '../gts/plan-graph.js';
import type { TaskPlanner } from '../gts/task-planner.js';

/** 用户反馈载荷 */
export interface FeedbackInput {
    type: string;
    content?: string;
    rating?: number;
    timestamp: number;
}

/** Conversation 内此前轮次（共享上下文的最小形态：用户输入 + 助手最终回答） */
export interface ConversationTurn {
    role: 'user' | 'assistant';
    text: string;
}

/** 执行 loop 的选择：default（既有串行 cursor）/ dynamic（节点驱动）。 */
export type RunLoopMode = 'default' | 'dynamic';

export interface RunOptions {
    userId?: string;
    /** Stable project identity used by personal memory and project wiki. */
    projectId?: string;
    /** 本次 Goal 的权限档位（composer 选择）；缺省用配置默认。 */
    permissionCeiling?: PermissionLevel;
    /** 轮次上限（UI 运行设置 → GoalContract.terminationPolicy.maxSteps）。 */
    maxSteps?: number;
    /** 成本上限 USD（UI 运行设置 → GoalContract.budget.maxCostUsd）。 */
    maxCostUsd?: number;
    /** 创建 Goal 时是否跑 triage（契约协商）；缺省 false，调用方显式开启；无可用 provider 自动回落 fallback。 */
    parseIntent?: boolean;
    /**
     * triage 只解析、不在创建阶段应用：Router/Plan 节点接管问题判定与协商决定。
     * 产品会话开启；旧测试/旧宿主缺省 false，保持创建即落契约的兼容行为。
     */
    deferTriage?: boolean;
    /** 工作区根路径；文件工具只允许读取该目录内文件 */
    workspaceRoot?: string;
    /** providerId → LLMProvider 覆盖（离线测试注入；优先生效） */
    llmProviders?: Record<string, LLMProvider>;
    /** 所属 Conversation id；session 作用域审批据此匹配。 */
    conversationId?: string;
    /** 同一 Conversation 内此前轮次，作为本轮前置消息（共享上下文） */
    history?: ConversationTurn[];
    /**
     * 是否从干净上下文开始（实验默认 true）：不自动注入项目黑板/历史摘要。
     * 黑板工具仍可按需显式调用，避免把上一次运行的结论当成本轮已知事实。
     */
    freshContext?: boolean;
    /** 推理强度（off/low/medium/high...），透传 provider 的 reasoningEffort */
    reasoningLevel?: string;
    /** 指定模型 id（provider 内 model id；缺省用 provider 默认模型） */
    modelId?: string;
    /** 系统提示追加片段（Feature 开关的 promptFragment 解析结果；只增文本）。 */
    promptFragment?: string;
    /** 本次运行的技能集合（显式给出则覆盖全局挂载；[] = 本次不带任何技能）。 */
    skillIds?: readonly string[];
    /** 本次运行的工具白名单收窄（与配置白名单取交集，永不放宽）。 */
    allowedTools?: readonly string[];
    /** 显式关闭的装配模块（features 段，如 'analysis'/'delegation'）；缺省全开。 */
    disabledModules?: readonly string[];
    /** 本次运行的开关值（Feature 解析结果；写入 flag.evaluated 审计）。 */
    flagOverrides?: Readonly<Record<string, boolean>>;
    /** 开关求值痕迹（复盘：值从默认来还是从运行期覆盖来）。 */
    flagTrace?: readonly { id: string; enabled: boolean; source: string }[];
    /** Optional hierarchical plan proposal; harness validates it before execution. */
    planProposal?: readonly PlannedTask[];
    /** Runtime-level Task Planner override (tests / custom hosts). Defaults to the LLM planner. */
    taskPlanner?: TaskPlanner;
    /** Enable automatic Task planning for this run. Product sessions default it on. */
    taskPlanning?: boolean;
    /** 本次运行的执行 loop；缺省 default。dynamic 暂不支持 resume。 */
    loopMode?: RunLoopMode;
    /** Explicit PromptPack ids. Matching still determines compatibility and budget. */
    promptPackIds?: readonly string[];
    /** Delegation depth. Root tasks are 0; runtime refuses deeper fanout at its cap. */
    delegationDepth?: number;
}

/** ConversationTurn[] → LLMMessage[]（user/assistant 文本消息）。 */
export function conversationMessages(turns: ConversationTurn[] | undefined): LLMMessage[] {
    if (turns === undefined || turns.length === 0) {
        return [];
    }
    return turns.map(
        (turn): LLMMessage =>
            turn.role === 'user'
                ? { role: 'user', content: [{ type: 'text', text: turn.text }] }
                : { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
    );
}
