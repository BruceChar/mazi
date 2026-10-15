import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_IGNORED_DIRS } from './naming.js';
import { WIKI_LOG_HEADING, type WikiEntry } from './store.js';

export interface WikiChangeFacts {
    project: string;
    workspace: string;
    changedPaths: readonly string[];
    tools: readonly string[];
    userRequest?: string;
    answer?: string;
}

export interface WikiSnapshotInput {
    project: string;
    workspace: string;
    currentSnapshot: string;
    recentEntries: readonly WikiEntry[];
    changedPaths: readonly string[];
}

export interface WikiSummarizer {
    /** 把本回合改动事实写成 1-3 条功能级变更条目。 */
    summarizeChanges(facts: WikiChangeFacts): Promise<string[]>;
    /** 重写状态快照区（返回 undefined 表示放弃刷新）。 */
    refreshSnapshot(input: WikiSnapshotInput): Promise<string | undefined>;
}

/** 路径 → 模块粒度：apps/api/src/x.ts → apps/api；README.md → README.md。 */
export function moduleOfPath(path: string): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    if (parts.length >= 2 && (parts[0] === 'apps' || parts[0] === 'packages')) {
        return parts[0] + '/' + parts[1];
    }
    return parts.length > 0 ? parts[0] : path;
}

export function changedModules(paths: readonly string[]): string[] {
    const modules = new Set<string>();
    for (const path of paths) modules.add(moduleOfPath(path));
    return [...modules].sort();
}

/** 模块目录分组（bootstrap 概览用）。 */
const SNAPSHOT_GROUPS = ['apps', 'packages', 'services', 'libs', 'modules'];
/** 项目约定文档（存在则在快照里点出）。 */
const CONVENTION_FILES = ['AGENT.md', 'AGENTS.md', 'CLAUDE.md'];

function safeReadJson(file: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        return parsed !== null && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

function isFile(file: string): boolean {
    try {
        return statSync(file).isFile();
    } catch {
        return false;
    }
}

function directoryNames(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter(
                (entry) =>
                    entry.isDirectory() &&
                    !entry.name.startsWith('.') &&
                    !DEFAULT_IGNORED_DIRS.includes(entry.name),
            )
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
}

function detectStack(workspace: string): string[] {
    const stack: string[] = [];
    const pkg = safeReadJson(join(workspace, 'package.json'));
    if (pkg !== undefined) {
        if (typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0) {
            stack.push(pkg.packageManager);
        }
        stack.push('Node.js');
    }
    if (isFile(join(workspace, 'pnpm-workspace.yaml')) || isFile(join(workspace, 'turbo.json'))) {
        stack.push('monorepo');
    }
    if (isFile(join(workspace, 'Cargo.toml'))) stack.push('Rust/Cargo');
    if (isFile(join(workspace, 'pyproject.toml')) || isFile(join(workspace, 'requirements.txt'))) {
        stack.push('Python');
    }
    if (isFile(join(workspace, 'go.mod'))) stack.push('Go');
    return [...new Set(stack)];
}

/**
 * 确定性项目概览快照：首次会话/无模型时的兜底（设计 §8）。
 * 只读工作区结构与技术栈，不含模型判断；可被 wiki.update 或 project-wiki 技能覆盖。
 */
export function bootstrapSnapshot(workspace: string, project: string): string {
    const directories = directoryNames(workspace);
    const modules: string[] = [];
    for (const group of SNAPSHOT_GROUPS) {
        if (!directories.includes(group)) continue;
        for (const child of directoryNames(join(workspace, group))) {
            modules.push(group + '/' + child);
        }
    }
    const others = directories.filter((name) => !SNAPSHOT_GROUPS.includes(name)).slice(0, 10);
    const stack = detectStack(workspace);
    const conventions = CONVENTION_FILES.filter((name) => isFile(join(workspace, name)));
    return [
        '## 项目概览',
        '- 项目：' + project + '（工作区 ' + workspace + '）',
        '- 技术栈：' + (stack.length > 0 ? stack.join('、') : '（未识别）'),
        '- 顶层目录：' + (directories.length > 0 ? directories.slice(0, 20).join('、') : '（空）'),
        '- 快照来源：runtime 自动生成（可被 wiki.update 或 project-wiki 技能刷新）',
        '',
        '## 结构与模块',
        ...(modules.length > 0
            ? modules.map((module) => '- ' + module)
            : ['- （未发现 apps/packages 等模块目录）']),
        ...others.map((name) => '- ' + name + '/'),
        '',
        '## 模块职责',
        '- （待补充：由会话或 project-wiki 技能按实际职责刷新）',
        '',
        '## 进行中的工作',
        '- （暂无记录；后续改动会追加到变更日志）',
        '',
        '## 约定与注意',
        ...(conventions.length > 0
            ? conventions.map((name) => '- 项目约定文档：' + name + '（按其约定执行）')
            : ['- （未发现 AGENT.md/AGENTS.md/CLAUDE.md）']),
    ].join('\n');
}

/** 确定性摘要（无模型/模型失败时的降级；保证记录不丢，设计 §7.3）。 */
export class TemplateSummarizer implements WikiSummarizer {
    async summarizeChanges(facts: WikiChangeFacts): Promise<string[]> {
        const modules = changedModules(facts.changedPaths);
        const count = facts.changedPaths.length;
        if (modules.length === 0) {
            return ['本次会话产生项目文件改动（' + count + ' 处）'];
        }
        const shown = modules.slice(0, 6).join('、');
        const suffix = modules.length > 6 ? ' 等 ' + modules.length + ' 个模块' : '';
        return ['更新 ' + shown + suffix + '（' + count + ' 处改动）'];
    }

    async refreshSnapshot(input: WikiSnapshotInput): Promise<string | undefined> {
        const modules = changedModules(input.changedPaths);
        const lines = [
            '## 项目概览',
            '（自动快照：项目 ' + input.project + '，工作区 ' + input.workspace + '）',
            '',
            '## 结构与模块',
            ...(modules.length > 0 ? modules.map((module) => '- ' + module) : ['- （暂无）']),
            '',
            '## 进行中的工作',
            ...(input.recentEntries.length > 0
                ? input.recentEntries
                      .slice(-5)
                      .map((entry) => '- ' + entry.ts + '：' + entry.change)
                : ['- （暂无）']),
        ];
        return lines.join('\n');
    }
}

export function buildChangePrompt(facts: WikiChangeFacts): string {
    const lines = [
        '你是项目 wiki 的记录员。把下面这次会话对项目文件的改动，写成 1-3 条【功能级】变更条目。',
        '要求：只描述改了什么功能/行为，不写文件名、不写代码细节；每条不超过 40 字；用中文。',
        '输出格式：JSON 字符串数组，例如 ["新增项目 wiki 的读取与注入","修复会话结束后快照未刷新"]。',
        '',
        '项目：' + facts.project,
        '改动模块：' + (changedModules(facts.changedPaths).join('、') || '（未知）'),
        '改动文件数：' + String(facts.changedPaths.length),
        '涉及工具：' + (facts.tools.join('、') || '（未知）'),
    ];
    if (facts.userRequest !== undefined && facts.userRequest.length > 0) {
        lines.push('用户请求：' + facts.userRequest.slice(0, 500));
    }
    if (facts.answer !== undefined && facts.answer.length > 0) {
        lines.push('助手结论：' + facts.answer.slice(0, 500));
    }
    return lines.join('\n');
}

export function buildSnapshotPrompt(input: WikiSnapshotInput): string {
    return [
        '你是项目 wiki 的维护者。根据当前快照与最近变更，重写项目状态快照。',
        '要求：保留并更新以下分区（缺失则补充）：## 项目概览、## 结构与模块、## 模块职责、## 进行中的工作、## 约定与注意。',
        '只输出快照 markdown，不要输出变更日志，不要输出文件名清单，总长不超过 400 字。',
        '',
        '项目：' + input.project,
        '工作区：' + input.workspace,
        '当前快照：',
        input.currentSnapshot.length > 0 ? input.currentSnapshot.slice(0, 4000) : '（空）',
        '',
        '最近变更：',
        input.recentEntries
            .slice(-10)
            .map((entry) => '- ' + entry.ts + ' | ' + entry.change)
            .join('\n') || '（无）',
        '',
        '本次改动模块：' + (changedModules(input.changedPaths).join('、') || '（未知）'),
    ].join('\n');
}

/** 解析模型输出：优先 JSON 数组，退回逐行条目；最多 3 条。 */
export function parseChangeLines(raw: string): string[] {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    const start = trimmed.indexOf('[');
    const end = trimmed.lastIndexOf(']');
    if (start >= 0 && end > start) {
        try {
            const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
            if (Array.isArray(parsed)) {
                return parsed
                    .filter((item): item is string => typeof item === 'string')
                    .map((item) => item.trim())
                    .filter((item) => item.length > 0)
                    .slice(0, 3);
            }
        } catch {
            // 非 JSON：退回逐行解析
        }
    }
    return trimmed
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*\d.、)\s]+/, '').trim())
        .filter((line) => line.length > 0)
        .slice(0, 3);
}

/** 模型摘要器：调用注入的 complete；任何失败回退 TemplateSummarizer。 */
export function createLlmSummarizer(
    complete: (prompt: string) => Promise<string>,
    fallback: WikiSummarizer = new TemplateSummarizer(),
): WikiSummarizer {
    return {
        async summarizeChanges(facts: WikiChangeFacts): Promise<string[]> {
            try {
                const parsed = parseChangeLines(await complete(buildChangePrompt(facts)));
                if (parsed.length > 0) return parsed;
            } catch {
                // 降级到模板
            }
            return fallback.summarizeChanges(facts);
        },
        async refreshSnapshot(input: WikiSnapshotInput): Promise<string | undefined> {
            try {
                const text = sanitizeSnapshot(await complete(buildSnapshotPrompt(input)));
                if (text !== undefined) return text;
            } catch {
                // 降级到模板
            }
            return fallback.refreshSnapshot(input);
        },
    };
}

/** 快照清洗：截掉模型误带的变更日志区；无分区标题视为无效。 */
export function sanitizeSnapshot(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const cut = trimmed.indexOf(WIKI_LOG_HEADING);
    const body = (cut >= 0 ? trimmed.slice(0, cut) : trimmed).trim();
    if (body.length === 0 || !body.includes('## ')) return undefined;
    return body;
}
