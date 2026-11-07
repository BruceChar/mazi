import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * A Markdown fenced-code opener must sit at the start of a line (0-3 spaces).
 * Nested triple backticks inside doc comments (e.g. `/// \`\`\`ignore`) are not
 * fences and must not hide a bare code answer.
 */
const FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/m;

/**
 * Unambiguous Markdown block structure: lists, tables, blockquotes, rules.
 * ATX headings are intentionally absent: a line starting with `#` is ambiguous
 * with a Python/shell comment (raw code), while prose answers are already
 * rejected by the code-line ratio below.
 */
const BLOCK_MARKER_RES: readonly RegExp[] = [
    /^\s{0,3}[-*+]\s+\S/, // unordered list
    /^\s{0,3}\d{1,3}[.)]\s+\S/, // ordered list
    /^\s{0,3}>\s?/, // blockquote
    /^\s{0,3}\|.*\|\s*$/, // table row
    /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, // horizontal rule
];

const CODE_COMMENT_RE = /^(?:\/\/|#!|#\s|\/\*|\*(?!\*)|--|;|%|#include|#define|#\[)/;
const CODE_KEYWORD_RE =
    /^(?:use|import|from|pub|fn|let|const|var|def|class|struct|enum|impl|trait|interface|type|module|namespace|package|mod|return|if|else|for|while|match|switch|case|async|await|yield|extern|static|unsafe|try|catch|throw|new|delete|do|loop|break|continue|assert|test|describe|it|print|println|console|func|package|select|insert|update|create|alter|drop|with|values)\b/;
const CODE_OPERATOR_RE = /=>|->|::|:=|&&|\|\||===|!==|==|!=|<=|>=|\+=|-=|\*=|=~/;

/** Whether a single line looks like source code (not Markdown prose). */
function isCodeLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    // Markdown emphasis/bold (**text**, __text__) is prose, not a code comment.
    if (/^(?:\*\*|__)/.test(trimmed)) return false;
    if (CODE_COMMENT_RE.test(trimmed) || CODE_KEYWORD_RE.test(trimmed)) return true;
    if (/^[}\])]/.test(trimmed)) return true;
    if (/[{};]/.test(trimmed)) return true;
    if (CODE_OPERATOR_RE.test(trimmed)) return true;
    // Indented lines are code in both bare source and Markdown code blocks.
    if (/^\s{2,}\S/.test(line)) return true;
    // Trailing separators are typical of code lines, not sentences.
    if (/[,)\]]$/.test(trimmed)) return true;
    return false;
}

/**
 * Whether the whole text is a single bare code block (no Markdown fence).
 * Such answers must not be fed through marked: indented lines become code
 * blocks and the rest becomes prose, splitting one snippet into many blocks.
 */
export function detectRawCode(text: string): boolean {
    if (!text || text.trim().length === 0) return false;
    // Already Markdown: let the normal renderer handle it.
    if (FENCE_OPEN_RE.test(text)) return false;
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    // A single line is too ambiguous (could be prose); require at least two.
    if (lines.length < 2) return false;
    if (lines.some((line) => BLOCK_MARKER_RES.some((re) => re.test(line)))) return false;
    const codeLines = lines.filter(isCodeLine).length;
    const codeRatio = codeLines / lines.length;
    // "Most lines are code" — prose answers carry far fewer code-ish lines.
    return codeRatio >= 0.9;
}

/** Escape HTML text content (&, <, >); quotes need no escaping inside <pre>. */
export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render decision for a model answer: raw code becomes one escaped
 * <pre><code> block (never re-parsed by marked); everything else returns null
 * so the caller runs marked + DOMPurify.
 */
export function markdownForRender(text: string): string | null {
    if (!detectRawCode(text)) return null;
    return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

/** Render model Markdown to sanitized HTML (GFM + DOMPurify). */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    // A bare code answer is rendered as one escaped block; marked would split it.
    const rawCode = markdownForRender(text);
    if (rawCode !== null) return rawCode;
    // breaks: render single newlines as <br> instead of relying on a container
    // white-space:pre-wrap, which turned HTML-source newlines into extra blank lines.
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    const clean = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
    });
    // Force safe external-link attributes on every anchor.
    const tmp = document.createElement('div');
    tmp.innerHTML = clean;
    tmp.querySelectorAll('a').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
    });
    return tmp.innerHTML;
}
