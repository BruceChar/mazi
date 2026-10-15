/**
 * capabilities/scaffold.ts —— 新建 Skill：写一个最小可用的 SKILL.md（docs/能力包规范.md §3/§6）。
 *
 * 面板「新建」只需 id + 名称 + 描述：生成 frontmatter（name/description）与正文骨架，
 * 作者随后在正文里写清「何时使用 / 步骤 / 输出」即可被模型按需加载。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_FILE } from '@mazi/core';
import type { SkillRoot, WritableSkillRootScope } from './source.js';

export const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface SkillScaffoldInput {
    id: string;
    name: string;
    description?: string;
    license?: string;
}

export interface SkillScaffoldResult {
    dir: string;
    path: string;
    content: string;
}

/** 某作用域对应的可写根（builtin 只读 → undefined）。 */
export function scaffoldRootOf(
    roots: readonly SkillRoot[],
    scope: WritableSkillRootScope,
): SkillRoot | undefined {
    return roots.find((root) => root.scope === scope);
}

function skillMdOf(input: SkillScaffoldInput, id: string, name: string): string {
    const description =
        input.description?.trim() || '待完善：' + name + '（写清楚做什么 + 什么时候用）';
    return [
        '---',
        'name: ' + name,
        'description: ' + description,
        ...(input.license !== undefined && input.license.trim().length > 0
            ? ['license: ' + input.license.trim()]
            : []),
        '---',
        '',
        '# ' + name,
        '',
        '## 何时使用',
        '',
        '（写清触发场景与典型请求；description 与这里决定模型会不会加载本 Skill。）',
        '',
        '## 步骤',
        '',
        '1. …',
        '2. …',
        '',
        '## 输出',
        '',
        '- …',
        '',
        '## 随包文件',
        '',
        '需要参考资料或脚本时放在本目录下（如 references/、scripts/），在正文里用相对路径引用。',
        '',
        '<!-- scaffold: ' + id + ' -->',
        '',
    ].join('\n');
}

/** 在指定根下创建 Skill 目录与 SKILL.md；目录已存在 / id 非法 / 名称为空 → 抛错。 */
export function scaffoldSkill(root: SkillRoot, input: SkillScaffoldInput): SkillScaffoldResult {
    if (root.scope === 'builtin') throw new Error('内置技能根只读，不支持新建');
    const id = input.id.trim();
    if (!SKILL_ID_PATTERN.test(id)) {
        throw new Error('技能 id 必须是 kebab-case（小写字母/数字/连字符）：' + id);
    }
    const name = input.name.trim();
    if (name.length === 0) throw new Error('技能名称不能为空');
    const dir = join(root.dir, id);
    if (existsSync(dir)) throw new Error('技能目录已存在：' + dir);
    const content = skillMdOf(input, id, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SKILL_FILE), content, 'utf8');
    return { dir, path: join(dir, SKILL_FILE), content };
}
