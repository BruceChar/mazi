/**
 * capabilities/skill-md.ts —— `SKILL.md` 解析与机械校验（docs/能力包规范.md §3）。
 *
 * 只解析 Agent Skills frontmatter 的常用子集：标量、内联列表 `[a, b]`、块列表 `- a`、
 * 一层嵌套块（原样保留为字符串）。不引入 YAML 依赖：Skill 元数据是扁平、可控的。
 */

import type {
    SkillDocument,
    SkillFrontmatter,
    SkillIssueCode,
    SkillValidationIssue,
} from '@mazi/core';

export type FrontmatterValue = string | string[];

export interface ParsedSkillFile {
    hasFrontmatter: boolean;
    malformed: boolean;
    fields: Record<string, FrontmatterValue>;
    body: string;
}

function stripQuotes(value: string): string {
    const trimmed = value.trim();
    const quoted =
        (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2);
    return quoted ? trimmed.slice(1, -1) : trimmed;
}

function parseValue(value: string): FrontmatterValue {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed
            .slice(1, -1)
            .split(',')
            .map((item) => stripQuotes(item))
            .filter((item) => item.length > 0);
    }
    return stripQuotes(trimmed);
}

/** 解析 frontmatter + 正文；首行不是 `---` 视为无 frontmatter。 */
export function parseSkillFile(raw: string): ParsedSkillFile {
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    if (lines[0]?.trim() !== '---') {
        return { hasFrontmatter: false, malformed: false, fields: {}, body: raw.trim() };
    }
    let closing = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index]?.trim() === '---') {
            closing = index;
            break;
        }
    }
    if (closing < 0) {
        return { hasFrontmatter: true, malformed: true, fields: {}, body: '' };
    }
    const fields: Record<string, FrontmatterValue> = {};
    let currentKey: string | undefined;
    let nested: string[] = [];
    const flushNested = (): void => {
        if (currentKey !== undefined && nested.length > 0 && fields[currentKey] === undefined) {
            fields[currentKey] = nested.join('\n');
        }
        nested = [];
    };
    for (const line of lines.slice(1, closing)) {
        if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
        const listMatch = /^\s*-\s+(.*)$/.exec(line);
        if (listMatch && currentKey !== undefined) {
            const existing = fields[currentKey];
            const item = stripQuotes(listMatch[1] ?? '');
            fields[currentKey] = Array.isArray(existing) ? [...existing, item] : [item];
            continue;
        }
        const pairMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
        if (pairMatch) {
            flushNested();
            currentKey = pairMatch[1] ?? '';
            const value = (pairMatch[2] ?? '').trim();
            fields[currentKey] = value.length > 0 ? parseValue(value) : [];
            continue;
        }
        if (currentKey !== undefined) nested.push(line.trim());
    }
    flushNested();
    return {
        hasFrontmatter: true,
        malformed: false,
        fields,
        body: lines
            .slice(closing + 1)
            .join('\n')
            .trim(),
    };
}

function asString(value: FrontmatterValue | undefined): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asList(value: FrontmatterValue | undefined): string[] | undefined {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value
        .split(/[\s,]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

const KNOWN_FIELDS = new Set([
    'name',
    'description',
    'when_to_use',
    'allowed-tools',
    'allowed_tools',
    'license',
]);

function firstNonEmptyLine(body: string): string | undefined {
    return body
        .split('\n')
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .find((line) => line.length > 0);
}

export interface BuildSkillDocumentInput {
    dir: string;
    dirName: string;
    path: string;
    raw: string;
    resources: readonly string[];
}

export interface BuildSkillDocumentResult {
    document?: SkillDocument;
    issues: SkillValidationIssue[];
}

/** 解析 + 校验：`description` 缺省回退正文首行；正文为空则拒绝。 */
export function buildSkillDocument(input: BuildSkillDocumentInput): BuildSkillDocumentResult {
    const issues: SkillValidationIssue[] = [];
    const add = (code: SkillIssueCode, message: string): void => {
        issues.push({ code, path: input.path, message });
    };
    const parsed = parseSkillFile(input.raw);
    if (!parsed.hasFrontmatter) {
        add('frontmatter.missing', 'SKILL.md 必须以 --- 包裹的 YAML frontmatter 开始');
    } else if (parsed.malformed) {
        add('frontmatter.invalid', 'frontmatter 未闭合（缺少结束的 ---）');
    }
    const body = parsed.body;
    if (body.trim().length === 0) add('body.empty', 'SKILL.md 正文为空');
    const description = asString(parsed.fields.description) ?? firstNonEmptyLine(body) ?? undefined;
    if (description === undefined) {
        add('description.missing', '缺少 description（frontmatter 与正文首行都为空）');
    }
    const metadata: Record<string, string | readonly string[]> = {};
    for (const [key, value] of Object.entries(parsed.fields)) {
        if (!KNOWN_FIELDS.has(key)) metadata[key] = value;
    }
    if (issues.length > 0 || description === undefined) return { issues };
    const whenToUse = asString(parsed.fields.when_to_use);
    const allowedTools = asList(parsed.fields['allowed-tools'] ?? parsed.fields.allowed_tools);
    const license = asString(parsed.fields.license);
    const frontmatter: SkillFrontmatter = {
        name: asString(parsed.fields.name) ?? input.dirName,
        description,
        ...(whenToUse !== undefined ? { whenToUse } : {}),
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(license !== undefined ? { license } : {}),
        metadata,
    };
    return {
        issues: [],
        document: {
            id: input.dirName,
            name: frontmatter.name,
            description: frontmatter.description,
            body,
            frontmatter,
            path: input.path,
            dir: input.dir,
            resources: [...input.resources].sort(),
            bytes: Buffer.byteLength(input.raw, 'utf8'),
        },
    };
}
