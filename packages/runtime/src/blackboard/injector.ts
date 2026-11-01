import { estimateTokens } from '../token-estimator.js';
import type { BlackboardSection, ProjectBlackboard } from './types.js';

function lines(title: string, values: readonly string[], limit = 12): string {
    if (values.length === 0) return `${title}：（空）`;
    return `${title}：\n${values
        .slice(0, limit)
        .map((value) => `- ${value}`)
        .join('\n')}`;
}

export function renderBlackboard(
    board: ProjectBlackboard,
    section: BlackboardSection = 'all',
): string {
    const summary = [
        `# 项目黑板：${board.name}`,
        `状态：${board.status}｜版本：v${board.version}｜项目：${board.projectId}`,
        `目的：${board.purpose}`,
        board.architectureSummary,
        lines('技术栈', board.stack),
        lines('核心模块', board.coreModules),
        lines('接口', board.interfaces),
        lines('约束', board.constraints),
    ].join('\n\n');
    const status = [
        lines('活跃目标', board.activeGoals),
        lines('已完成', board.completedMilestones),
        lines('下一步', board.nextActions),
        lines('最近变化', board.recentChanges),
    ].join('\n\n');
    const issues = [lines('已知问题', board.knownIssues), lines('决策', board.decisions)].join(
        '\n\n',
    );
    switch (section) {
        case 'summary':
            return summary;
        case 'architecture':
            return [
                summary,
                lines('核心模块', board.coreModules),
                lines('接口', board.interfaces),
            ].join('\n\n');
        case 'status':
            return status;
        case 'issues':
            return issues;
        case 'decisions':
            return lines('决策', board.decisions);
        case 'all':
            return [summary, status, issues].join('\n\n');
    }
}

export function renderBlackboardInjection(board: ProjectBlackboard, budgetTokens = 700): string {
    const full = renderBlackboard(board, 'all');
    if (estimateTokens(full) <= budgetTokens) return full;
    const header = `# 项目黑板：${board.name}（v${board.version}）`;
    const blocks = [
        `状态：${board.status}`,
        `目的：${board.purpose}`,
        board.architectureSummary,
        lines('活跃目标', board.activeGoals, 5),
        lines('下一步', board.nextActions, 5),
        lines('最近变化', board.recentChanges, 5),
        '完整章节和证据请调用 blackboard.read。',
    ];
    const selected: string[] = [header];
    let used = estimateTokens(header);
    for (const block of blocks) {
        const cost = estimateTokens(block);
        if (used + cost > budgetTokens) break;
        selected.push(block);
        used += cost;
    }
    if (selected.length === 1) selected.push(`目的：${board.purpose.slice(0, 200)}`);
    return selected.join('\n\n');
}
