/**
 * Skill 测试夹具：在临时 skills 根下写一个含 SKILL.md 的 Skill 目录。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SkillFixtureOptions {
    /** frontmatter 字段（缺省 name = id、description = 自动描述）。 */
    frontmatter?: Record<string, string | string[]>;
    /** 正文（缺省骨架）。 */
    body?: string;
    /** 随包文件：相对路径 → 内容。 */
    resources?: Record<string, string>;
    /** 完全自定义 SKILL.md（覆盖 frontmatter/body）。 */
    raw?: string;
}

function skillMd(id: string, options: SkillFixtureOptions): string {
    const fields: Record<string, string | string[]> = {
        name: id,
        description: '技能 ' + id + ' 的描述：做什么 + 什么时候用',
        ...options.frontmatter,
    };
    const head = Object.entries(fields).map(([key, value]) =>
        key + ': ' + (Array.isArray(value) ? '[' + value.join(', ') + ']' : value),
    );
    const body = options.body ?? '# ' + id + '\n\n## 步骤\n\n1. 第一步';
    return ['---', ...head, '---', '', body, ''].join('\n');
}

/** 写入 Skill 目录与 SKILL.md（返回目录）。 */
export function writeSkill(root: string, id: string, options: SkillFixtureOptions = {}): string {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), options.raw ?? skillMd(id, options), 'utf8');
    for (const [rel, content] of Object.entries(options.resources ?? {})) {
        const target = join(dir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
    }
    return dir;
}
