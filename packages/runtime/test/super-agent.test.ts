import { describe, expect, it } from 'vitest';
import { SuperAgent, classifyTaskKind } from '../src/agent/index.js';
import { DEFAULT_PROMPT_PACKS, PromptPackRegistry } from '../src/prompts/index.js';

describe('SuperAgent', () => {
    it('classifies risk, memory, data, debug, coding, research and general requests', () => {
        expect(classifyTaskKind('删除生产数据库', [], 'irreversible')).toBe('security');
        expect(classifyTaskKind('继续上次那个项目')).toBe('memory');
        expect(classifyTaskKind('分析 SQL 数据集')).toBe('data');
        expect(classifyTaskKind('修复测试失败')).toBe('debug');
        expect(classifyTaskKind('实现一个新接口', ['sd'])).toBe('coding');
        expect(classifyTaskKind('调研 benchmark 来源')).toBe('research');
        expect(classifyTaskKind('你好')).toBe('general');
    });

    it('selects a project prompt and records planner, verifier and memory plans', () => {
        const registry = new PromptPackRegistry([
            ...DEFAULT_PROMPT_PACKS,
            {
                id: 'project-agent',
                name: 'Agent 项目',
                description: 'Agent 编排规则',
                version: 2,
                priority: 30,
                matcher: { projectIds: ['p-agent'], taskKinds: ['coding'] },
                module: '始终记录 PromptPack 选择依据。',
                budgetTokens: 100,
            },
        ]);
        const decision = new SuperAgent(registry).decide({
            userId: 'u1',
            projectId: 'p-agent',
            input: '实现 verifier',
            tools: ['fs.read', 'sd'],
        });
        expect(decision).toMatchObject({
            taskKind: 'coding',
            plannerId: 'task-graph',
            verifierId: 'independent-default',
            blackboardRequired: true,
            memoryPlan: { readUser: true, readProject: true, writeEpisode: true },
        });
        expect(decision.promptPackIds).toContain('project-agent');
        expect(decision.reason).toContain('project-agent:project:p-agent');
        expect(decision.promptMatch.estimatedTokens).toBeLessThanOrEqual(1400);
    });

    it('does not change permissions when selecting a prompt pack', () => {
        const decision = new SuperAgent(new PromptPackRegistry()).decide({
            input: '发布到生产环境',
            tools: ['shell.run'],
            riskLevel: 'irreversible',
            explicitPackIds: ['general'],
        });
        expect(decision.taskKind).toBe('security');
        expect(decision.promptPackIds).not.toContain('general');
        expect(decision).not.toHaveProperty('permissionCeiling');
        expect(decision).not.toHaveProperty('allowedTools');
    });
});
