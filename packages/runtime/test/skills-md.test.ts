/**
 * SKILL.md 解析与机械校验（docs/能力包规范.md §3、CP SK-1）。
 */

import { describe, expect, it } from 'vitest';
import { buildSkillDocument, parseSkillFile } from '../src/capabilities/index.js';

function build(raw: string, dirName = 'demo') {
    return buildSkillDocument({
        dir: '/tmp/skills/' + dirName,
        dirName,
        path: '/tmp/skills/' + dirName + '/SKILL.md',
        raw,
        resources: [],
    });
}

describe('SKILL.md：frontmatter 与正文', () => {
    it('完整 frontmatter：name/description/when_to_use/allowed-tools/license + 未知字段进 metadata', () => {
        const raw = [
            '---',
            'name: success-diary',
            'description: 记录每日成就并复盘。',
            'when_to_use: 用户说想写日记',
            'allowed-tools: [fs.read, rg]',
            'license: MIT',
            'version: 1.2.0',
            '---',
            '',
            '# 成功日记',
            '',
            '步骤…',
        ].join('\n');
        const result = build(raw);
        expect(result.issues).toEqual([]);
        const document = result.document;
        expect(document?.id).toBe('demo');
        expect(document?.name).toBe('success-diary');
        expect(document?.description).toBe('记录每日成就并复盘。');
        expect(document?.frontmatter.whenToUse).toBe('用户说想写日记');
        expect(document?.frontmatter.allowedTools).toEqual(['fs.read', 'rg']);
        expect(document?.frontmatter.license).toBe('MIT');
        expect(document?.frontmatter.metadata.version).toBe('1.2.0');
        expect(document?.body).toBe('# 成功日记\n\n步骤…');
        expect(document?.bytes).toBeGreaterThan(0);
    });

    it('allowed-tools 支持块列表与空格分隔', () => {
        const block = ['---', 'description: x', 'allowed-tools:', '  - Read', '  - Grep', '---', '正文'].join('\n');
        expect(build(block).document?.frontmatter.allowedTools).toEqual(['Read', 'Grep']);
        const spaced = ['---', 'description: x', 'allowed-tools: Read Grep', '---', '正文'].join('\n');
        expect(build(spaced).document?.frontmatter.allowedTools).toEqual(['Read', 'Grep']);
    });

    it('description 缺省回退正文首行（去掉 # 前缀）', () => {
        const raw = ['---', 'name: demo', '---', '', '# 标题即描述', '', '正文'].join('\n');
        expect(build(raw).document?.description).toBe('标题即描述');
    });

    it('无 frontmatter → frontmatter.missing', () => {
        const result = build('# 只有正文');
        expect(result.document).toBeUndefined();
        expect(result.issues.map((issue) => issue.code)).toContain('frontmatter.missing');
    });

    it('frontmatter 未闭合 → frontmatter.invalid', () => {
        const result = build(['---', 'description: x', '正文'].join('\n'));
        expect(result.issues.map((issue) => issue.code)).toContain('frontmatter.invalid');
    });

    it('正文为空 → body.empty', () => {
        const result = build(['---', 'description: x', '---', '', '   '].join('\n'));
        expect(result.issues.map((issue) => issue.code)).toContain('body.empty');
    });

    it('description 与正文首行都为空 → description.missing', () => {
        const result = build(['---', 'name: demo', '---', '', '##', ''].join('\n'));
        expect(result.issues.map((issue) => issue.code)).toContain('description.missing');
    });

    it('parseSkillFile：无 frontmatter 时整篇都是正文', () => {
        const parsed = parseSkillFile('纯正文');
        expect(parsed.hasFrontmatter).toBe(false);
        expect(parsed.body).toBe('纯正文');
    });
});
