/**
 * 语音转写文本的纯函数：追加、清洗、丢弃判定。
 *
 * 规则（设计 §5.4）：
 * - 中文直接拼接；
 * - 英文单词 / 数字之间补一个空格；
 * - 空白 / 纯标点 / 过短的 final 丢弃，避免误发送。
 */

/** 控制字符与零宽字符（转写结果里不应出现；防御性清理）。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 这些控制字符正是要清理的目标
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ZERO_WIDTH_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** 清洗一段转写：去控制字符/零宽字符，压缩空白，trim。保留单个换行。 */
export function sanitizeTranscript(input: unknown): string {
    if (typeof input !== 'string') return '';
    return input
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL_CHARS, '')
        .replace(ZERO_WIDTH_CHARS, '')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/** ASCII 英文/数字（需要空格分隔的边界）。 */
function isLatinWordChar(char: string): boolean {
    return /[A-Za-z0-9]/.test(char);
}

/**
 * 把一段 final 文本追加到现有草稿。
 * 中文直接拼接；英文/数字之间补空格；已有草稿以空白结尾时不重复补。
 */
export function appendTranscript(existing: string, addition: string): string {
    const base = typeof existing === 'string' ? existing : '';
    const clean = sanitizeTranscript(addition);
    if (!clean) return base;
    if (!base.trim()) return clean;

    const last = base[base.length - 1] ?? '';
    const first = clean[0] ?? '';
    const needSpace = isLatinWordChar(last) && isLatinWordChar(first);
    if (/\s$/.test(base)) return base + clean;
    return base + (needSpace ? ' ' : '') + clean;
}

/** 去掉标点/空白后剩余的有效字符数。 */
export function meaningfulLength(text: string): number {
    const clean = sanitizeTranscript(text).replace(/\s+/g, '');
    if (!clean) return 0;
    return clean.replace(
        /[.,!?;:'"\u3001\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u2026\u2014\u2013\-()\uff08\uff09[\]\u3010\u3011{}<>\u300a\u300b/@#$%^&*+=~`|\\]/g,
        '',
    ).length;
}

/**
 * final 是否应丢弃：空白、纯标点、或有效字符数低于 minChars。
 * minChars 来自服务端 limits.minFinalChars（默认 2）。
 */
export function shouldDiscardFinal(text: string, minChars = 2): boolean {
    const clean = sanitizeTranscript(text);
    if (!clean) return true;
    const length = meaningfulLength(clean);
    return length < Math.max(1, minChars);
}

/** 仅用于 ghost 展示：去掉换行，保持单行。 */
export function formatPartial(text: unknown): string {
    return sanitizeTranscript(text).replace(/\n+/g, ' ');
}
