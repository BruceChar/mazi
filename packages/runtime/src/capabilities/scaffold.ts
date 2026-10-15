/**
 * capabilities/scaffold.ts —— 新建 Skill：按「主体分栏」生成 SKILL.md（docs/能力包规范.md §3/§6）。
 *
 * 表单分栏与正文一一对应：何时使用（trigger）/ 步骤 / 输出 / 注意事项；
 * 任一分栏填写即写进正文，全部留空则落一份带占位提示的骨架（保证 SKILL.md 合法可用）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILL_FILE } from '@mazi/core';
import type { SkillRoot, WritableSkillRootScope } from './source.js';

export const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface SkillScaffoldInput {
    id: string;
    name: string;
    /** frontmatter description：做什么 + 什么时候用（模型路由用）。 */
    description?: string;
    /** 主体分栏：何时使用（trigger）。 */
    whenToUse?: string;
    /** 主体分栏：步骤（每行一步）。 */
    steps?: string;
    /** 主体分栏：输出（每行一条）。 */
    output?: string;
    /** 主体分栏：注意事项 / 边界（每行一条）。 */
    notes?: string;
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

/** 多行文本 → 行数组（容忍用户自己写的 - / 1. 前缀）。 */
function listLines(value: string | undefined): string[] {
    return (value ?? '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
        .filter((line) => line.length > 0);
}

function numbered(items: readonly string[]): string[] {
    return items.map((item, index) => index + 1 + '. ' + item);
}

function bulleted(items: readonly string[]): string[] {
    return items.map((item) => '- ' + item);
}

function section(title: string, body: readonly string[]): string[] {
    return body.length === 0 ? [] : ['## ' + title, '', ...body, ''];
}

function bodyOf(input: SkillScaffoldInput): string[] {
    const trigger = listLines(input.whenToUse);
    const steps = listLines(input.steps);
    const output = listLines(input.output);
    const notes = listLines(input.notes);
    const filled = trigger.length > 0 || steps.length > 0 || output.length > 0 || notes.length > 0;
    if (!filled) {
        return [
            '## 何时使用',
            '',
            '（写清触发场景与典型请求；description 与这里决定模型会不会加载本 Skill。）',
            '',
            '## 步骤',
            '',
            '1. …',
            '',
            '## 输出',
            '',
            '- …',
            '',
        ];
    }
    return [
        ...section('何时使用', trigger.length > 1 ? bulleted(trigger) : trigger),
        ...section('步骤', numbered(steps)),
        ...section('输出', bulleted(output)),
        ...section('注意事项', bulleted(notes)),
    ];
}

function skillMdOf(input: SkillScaffoldInput, id: string, name: string): string {
    const description =
        input.description?.trim() || '待完善：' + name + '（写清楚做什么 + 什么时候用）';
    const license = input.license?.trim();
    return [
        '---',
        'name: ' + name,
        'description: ' + description,
        ...(license !== undefined && license.length > 0 ? ['license: ' + license] : []),
        '---',
        '',
        '# ' + name,
        '',
        ...bodyOf(input),
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
