/**
 * Project Wiki 摘要收敛：Wiki 维护 Agent 常以 Markdown fenced code block
 * （例如 `wiki(checkpoint): ok` 报告）结束，直接投影到页面提示或
 * `state/current.md` 的活动行会变成绿色代码块噪音。此处把任意摘要压成
 * 单行人读文本：丢弃 fenced 代码与 HTML 注释，去掉 Markdown 行首标记和
 * 行内反引号，折叠空白并截断。
 */
export const WIKI_SUMMARY_LIMIT = 160;

const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const LEADING_MARKER_RE = /^(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/;

export function compactWikiSummary(
    value: string | null | undefined,
    limit = WIKI_SUMMARY_LIMIT,
): string {
    const source = String(value ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/<!--[\s\S]*?-->/g, '');
    if (source.trim().length === 0 || limit <= 0) return '';
    const kept: string[] = [];
    let fence: string | null = null;
    for (const raw of source.split('\n')) {
        const line = raw.trim();
        if (fence !== null) {
            // 只认与开栅栏同字符、且除栅栏外没有内容的收尾行。
            if (line.startsWith(fence) && line.replace(/[`~]/g, '').trim() === '') {
                fence = null;
            }
            continue;
        }
        if (FENCE_LINE_RE.test(line)) {
            fence = line.match(FENCE_LINE_RE)?.[1] ?? null;
            continue;
        }
        const cleaned = line.replace(LEADING_MARKER_RE, '').replace(/`+/g, '').trim();
        if (cleaned.length > 0) kept.push(cleaned);
    }
    const compacted = kept.join(' ').replace(/\s+/g, ' ').trim();
    if (compacted.length === 0) return '';
    const characters = Array.from(compacted);
    if (characters.length <= limit) return compacted;
    const truncated = characters
        .slice(0, Math.max(1, limit - 1))
        .join('')
        .trimEnd();
    return `${truncated}…`;
}
