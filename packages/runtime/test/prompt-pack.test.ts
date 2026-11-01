import { describe, expect, it } from 'vitest';
import { CORE_PROMPT, DEFAULT_PROMPT_PACKS, PromptPackRegistry } from '../src/prompts/index.js';

describe('PromptPackRegistry', () => {
    it('selects project-specific and task-specific modules with trace', () => {
        const registry = new PromptPackRegistry([
            ...DEFAULT_PROMPT_PACKS,
            {
                id: 'project-agent',
                name: 'Agent 项目',
                description: '当前项目专用规则',
                version: 3,
                priority: 20,
                matcher: { projectIds: ['p-agent'], taskKinds: ['coding'] },
                module: '## Agent 项目规则\n- 所有工具调用必须留痕。',
                budgetTokens: 200,
            },
        ]);
        const result = registry.match({
            projectId: 'p-agent',
            taskKind: 'coding',
            input: '实现 verifier',
            tools: ['fs.read', 'sd', 'shell.run'],
            projectTags: ['software'],
        });
        expect(result.selected.map((pack) => pack.id)).toContain('project-agent');
        expect(result.trace).toContainEqual(
            expect.objectContaining({ packId: 'project-agent', version: 3 }),
        );
        expect(result.prompt.startsWith(CORE_PROMPT)).toBe(true);
        expect(result.prompt).toContain('Agent 项目规则');
        expect(result.estimatedTokens).toBeLessThanOrEqual(1400);
    });

    it('does not inject unmatched task modules into unrelated projects', () => {
        const registry = new PromptPackRegistry();
        const result = registry.match({
            projectId: 'p-other',
            taskKind: 'general',
            input: '你好',
            tools: [],
        });
        expect(result.selected.map((pack) => pack.id)).toEqual(['general']);
        expect(result.prompt).not.toContain('软件工程执行规范');
        expect(result.index).toContain('软件工程');
    });

    it('honors explicit selection and conflict resolution', () => {
        const registry = new PromptPackRegistry([
            {
                id: 'a',
                name: 'A',
                description: 'A',
                version: 1,
                priority: 10,
                matcher: { taskKinds: ['general'] },
                module: 'A module',
                conflictsWith: ['b'],
            },
            {
                id: 'b',
                name: 'B',
                description: 'B',
                version: 1,
                priority: 9,
                matcher: { taskKinds: ['general'] },
                module: 'B module',
            },
        ]);
        const result = registry.match({
            taskKind: 'general',
            input: 'x',
            explicitPackIds: ['a', 'b'],
        });
        expect(result.selected.map((pack) => pack.id)).toEqual(['a']);
        expect(result.prompt).not.toContain('B module');
    });

    it('supports register, update and remove', () => {
        const registry = new PromptPackRegistry([]);
        registry.register({
            id: 'x',
            name: 'X',
            description: 'X',
            version: 1,
            matcher: { taskKinds: ['coding'] },
            module: 'x',
        });
        registry.register({
            id: 'x',
            name: 'X2',
            description: 'X2',
            version: 2,
            matcher: { taskKinds: ['coding'] },
            module: 'x2',
        });
        expect(registry.list()[0]).toMatchObject({ id: 'x', version: 2, name: 'X2' });
        expect(registry.remove('x')).toBe(true);
        expect(registry.list()).toEqual([]);
    });
});
