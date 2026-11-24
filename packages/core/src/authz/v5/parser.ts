/**
 * V5 命令解析器（§4 / D12）。
 *
 * 复合命令必须先拆解为完整 op 链再执行；任一 op 落 ask 且未获批 → 整链暂停
 * （原子语义）。拆不动 → 整链进 hazard 且不可指纹化；内联解释器（sh -c、
 * python -c、eval）按不可拆处理。
 *
 * 本模块只做保守拆分：引号内分隔符误拆只会让链变长（任一 ask 整链暂停），
 * 不会漏放；语义级 shell 解析由更完整的解析器后续替换。
 */

import { isHazard, type Op } from './decision.js';

export interface ParsedOp {
    raw: string;
    tokens: string[];
}

export interface ParseResult {
    ops: ParsedOp[];
    /** 拆解失败 / 未知语法 → hazard + 不可指纹化。 */
    unparsed: boolean;
    reason?: string;
}

/** 内联解释器：`sh -c` / `python -c` / `eval` 整条不可拆。 */
const INLINE_INTERPRETER = /(^|\s)(sh|bash|zsh|fish|python|python3|node)\s+-c\s/;
const EVAL = /(^|\s)eval\s/;
/** 命令替换：$(...) 与反引号。 */
const COMMAND_SUBSTITUTION = /\$\(.*\)|`[^`]*`/;

function tokenize(raw: string): string[] {
    return raw.trim().split(/\s+/).filter(Boolean);
}

/** 按 && / || / ; / | 拆分为子命令链。 */
function splitChain(command: string): string[] {
    return command
        .split(/&&|\|\||[;|]/)
        .map((part) => part.trim())
        .filter(Boolean);
}

export function parseCommand(command: string): ParseResult {
    const trimmed = command.trim();
    if (trimmed.length === 0) {
        return { ops: [], unparsed: true, reason: '空命令' };
    }
    if (INLINE_INTERPRETER.test(trimmed) || EVAL.test(trimmed)) {
        return {
            ops: [{ raw: trimmed, tokens: tokenize(trimmed) }],
            unparsed: true,
            reason: '内联解释器不可拆，整条 hazard 且不可指纹化',
        };
    }
    if (COMMAND_SUBSTITUTION.test(trimmed)) {
        return {
            ops: [{ raw: trimmed, tokens: tokenize(trimmed) }],
            unparsed: true,
            reason: '命令替换无法静态拆解',
        };
    }
    const parts = splitChain(trimmed);
    return {
        ops: parts.map((raw) => ({ raw, tokens: tokenize(raw) })),
        unparsed: false,
    };
}

export interface RecheckResult {
    /** 批准后目标变为 hazard（external/critical/符号链接变更）→ 整链回弹窗。 */
    changed: boolean;
    hazardNow: boolean;
}

/** TOCTOU：每个 op 真正落盘/spawn 前重新校验分类（§4）。 */
export function recheckTarget(before: Op, after: Op): RecheckResult {
    const hazardNow = isHazard(after);
    return { changed: hazardNow && !isHazard(before), hazardNow };
}
