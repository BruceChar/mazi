import { describe, expect, it } from 'vitest';
import { resolveRoleSkillIds } from '../src/agent/role-skills.js';

describe('resolveRoleSkillIds（角色技能 ∪ 全局挂载）', () => {
    it('角色未声明技能时返回 undefined，沿用全局挂载', () => {
        expect(resolveRoleSkillIds(['project-wiki'])).toBeUndefined();
        expect(resolveRoleSkillIds(['project-wiki'], [])).toBeUndefined();
    });

    it('角色技能与全局挂载取并集并去重排序', () => {
        expect(resolveRoleSkillIds(['project-wiki', 'shared'], ['shared', 'doc-writer'])).toEqual([
            'doc-writer',
            'project-wiki',
            'shared',
        ]);
    });

    it('角色技能可覆盖只有角色声明的场景', () => {
        expect(resolveRoleSkillIds([], ['doc-writer'])).toEqual(['doc-writer']);
    });
});
