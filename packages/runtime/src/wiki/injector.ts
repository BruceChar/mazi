import { estimateTokens } from '../token-estimator.js';
import { WIKI_LOG_HEADING, type WikiDoc } from './store.js';

export const DEFAULT_INJECT_BUDGET_TOKENS = 1500;
export const DEFAULT_RECENT_ENTRIES = 10;

/** 快照区分区的注入优先级（设计 §8）。 */
export const SECTION_PRIORITY = [
    '项目概览',
    '进行中的工作',
    '结构与模块',
    '模块职责',
    '约定与注意',
];

export interface WikiInjectionOptions {
    budgetTokens?: number;
    recentEntries?: number;
}

export interface WikiSection {
    title: string;
    body: string;
}

export function splitSections(snapshot: string): WikiSection[] {
    const lines = snapshot.split(/\r?\n/);
    const sections: WikiSection[] = [];
    let title: string | undefined;
    let buffer: string[] = [];
    const flush = (): void => {
        if (title === undefined) return;
        sections.push({ title, body: buffer.join('\n').trim() });
    };
    for (const line of lines) {
        if (line.startsWith('## ')) {
            flush();
            title = line.slice(3).trim();
            buffer = [];
            continue;
        }
        if (title !== undefined) buffer.push(line);
    }
    flush();
    return sections;
}

function sectionRank(section: WikiSection): number {
    const index = SECTION_PRIORITY.indexOf(section.title);
    return index < 0 ? SECTION_PRIORITY.length : index;
}

/** 无 wiki 时的提示片段（不注入空内容；设计 §8）。 */
export function wikiMissingHint(): string {
    return [
        '## 项目 wiki',
        '本项目尚无 wiki：新会话暂无项目状态快照。',
        '若本次会话产生了结构性改动，收尾时用 wiki.update 刷新快照。',
    ].join('\n');
}

/** 生成注入片段：快照分区按优先级截断 + 最近 N 条变更；超预算标注截断。 */
export function buildWikiInjection(
    doc: WikiDoc | undefined,
    options: WikiInjectionOptions = {},
): string {
    if (doc === undefined) return wikiMissingHint();
    const budget = options.budgetTokens ?? DEFAULT_INJECT_BUDGET_TOKENS;
    const recent = options.recentEntries ?? DEFAULT_RECENT_ENTRIES;
    const header = '## 项目 wiki（' + doc.project + '，更新于 ' + (doc.updatedAt ?? '未知') + '）';
    const hint = '更完整的历史请调用 wiki.read（section: snapshot | log | all）。';
    let used = estimateTokens(header) + estimateTokens(hint);
    let truncated = false;
    const blocks: string[] = [];
    const sections = [...splitSections(doc.snapshot)].sort(
        (left, right) => sectionRank(left) - sectionRank(right),
    );
    for (const section of sections) {
        const block = '### ' + section.title + '\n' + section.body;
        const cost = estimateTokens(block);
        if (used + cost > budget) {
            truncated = true;
            continue;
        }
        blocks.push(block);
        used += cost;
    }
    const tail = doc.entries.slice(-Math.max(recent, 0));
    if (tail.length > 0) {
        const accepted: string[] = [];
        let overflow = false;
        for (let index = tail.length - 1; index >= 0; index -= 1) {
            const line = '- ' + tail[index].ts + ' | ' + tail[index].change;
            const cost = estimateTokens(line);
            if (used + cost > budget) {
                overflow = true;
                break;
            }
            accepted.unshift(line);
            used += cost;
        }
        if (accepted.length > 0) blocks.push('### 最近变更\n' + accepted.join('\n'));
        if (overflow) truncated = true;
    }
    const parts = [header, ...(blocks.length > 0 ? [blocks.join('\n\n')] : []), hint];
    if (truncated) parts.push('（已截断，完整内容见 wiki.read）');
    return parts.join('\n\n');
}

/** 供 wiki.read 工具使用：按分区返回文本。 */
export function renderWikiSection(
    doc: WikiDoc | undefined,
    section: 'snapshot' | 'log' | 'all',
    limit?: number,
): string {
    if (doc === undefined) return '（暂无 wiki）';
    if (section === 'snapshot') return doc.snapshot.length > 0 ? doc.snapshot : '（快照为空）';
    const entries = limit !== undefined && limit > 0 ? doc.entries.slice(-limit) : doc.entries;
    const log = entries.map((entry) => '- ' + entry.ts + ' | ' + entry.change).join('\n');
    if (section === 'log') return log.length > 0 ? log : '（暂无变更记录）';
    return ['# ' + doc.project + ' 项目 wiki', '', doc.snapshot, '', WIKI_LOG_HEADING, log].join(
        '\n',
    );
}
