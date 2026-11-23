import type { ContextView, ObserveFact, Phase, WorkflowState } from './types.js';

/** 节点 prompt 的基座与角色段（角色段由调用方按相位提供）。 */
export interface PromptSections {
    readonly base: string;
    readonly byRole: Record<Phase, string>;
}

/** 事实摘要（Observe 已收敛，这里只做渲染截断）。 */
function renderFacts(facts: readonly ObserveFact[], maxFacts: number): string {
    return facts
        .slice(-maxFacts)
        .map((fact) => `- [${fact.kind}] ${fact.text}`)
        .join('\n');
}

function renderPlan(state: WorkflowState): string {
    if (state.plan === undefined) return '（无计划）';
    return state.plan.tasks.map((task) => `- ${task.id} [${task.status}] ${task.title}`).join('\n');
}

/**
 * 渲染三段式视图：基座（稳定前缀）→ 角色段 → 工作集（每步变化）。
 * 超过 charBudget 时从工作集头部裁剪，保证基座与角色段完整。
 */
export function buildContextView(
    state: WorkflowState,
    role: Phase,
    sections: PromptSections,
    maxFacts: number,
    charBudget = 6000,
): ContextView {
    const workingSet = [
        `开放任务：${state.plan?.tasks.filter((task) => task.status === 'open').length ?? 0}`,
        `失败次数：${state.failures}　验收项：${state.acceptance.length}　判定：${state.verdict}`,
        '计划：',
        renderPlan(state),
        '最近事实：',
        renderFacts(state.facts, maxFacts),
    ].join('\n');
    const trimmed = workingSet.length > charBudget ? workingSet.slice(-charBudget) : workingSet;
    return {
        base: sections.base,
        role: sections.byRole[role],
        workingSet: trimmed,
        ...(state.handoff !== undefined ? { handoff: state.handoff } : {}),
        charBudget,
    };
}
