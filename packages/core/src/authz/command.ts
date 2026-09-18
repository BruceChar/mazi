/**
 * Shell 命令分类与审批目标（approval target）。
 *
 * 规则**数据化**：命令清单来自 CommandPolicy（运行时从 ~/.mazi/config/auth 加载），
 * 代码里只保留与具体命令无关的硬条件：
 * - shell 元字符（分号/管道/重定向/反引号/$ 展开/换行）→ 不得放宽为只读；
 * - 解释器/提权命令（sh/bash/zsh/fish/eval/exec/source/sudo/su/doas）恒为 dangerous；
 * - 多子命令工具未列出的子命令恒为 dangerous（保守默认）；
 * - 无任何规则命中的命令 → unknown，正常走 shell.run（完整命令行 key）。
 *
 * 类别：
 * - dangerous：永远逐次审批（tier 下限，不受“完全”档放宽）；
 * - readonly：只读且无元字符，放宽为“命令名”粒度；
 * - network：出网命令，交出站账本裁决（clean 放行 / 有敏感读转审批）；
 * - unknown：完整命令行粒度。
 */

import type { ApprovalScope, ToolRegistration } from './gateway-types.js';
import { stableStringify } from './hash.js';
import type { ValueProjection } from './types.js';

export type CommandClass = 'dangerous' | 'readonly' | 'network' | 'unknown';

/** 运行时可配置的命令规则（JSON 可序列化）。 */
export interface CommandPolicy {
    /** 高危命令词；永远逐次审批。 */
    dangerousHeads?: readonly string[];
    /** 只读命令词；无 shell 元字符时放宽为命令名粒度。 */
    readonlyHeads?: readonly string[];
    /** 出网命令词；交出站账本裁决。 */
    networkHeads?: readonly string[];
    /** 多子命令工具：head 到只读子命令白名单；未列出的子命令一律 dangerous。 */
    subcommands?: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_COMMAND_POLICY: CommandPolicy = Object.freeze({});

/** 结构性硬条件：解释器 / 提权命令恒为危险，不随配置放宽。 */
const HARD_DANGEROUS_HEADS: readonly string[] = [
    'sh',
    'bash',
    'zsh',
    'fish',
    'eval',
    'exec',
    'source',
    'sudo',
    'su',
    'doas',
];

/** 编译后的规则（集合查询，供网关构造时编译一次）。 */
export interface CommandRules {
    dangerousHeads: ReadonlySet<string>;
    readonlyHeads: ReadonlySet<string>;
    networkHeads: ReadonlySet<string>;
    subcommands: Readonly<Record<string, ReadonlySet<string>>>;
}

export function compileCommandPolicy(policy: CommandPolicy = EMPTY_COMMAND_POLICY): CommandRules {
    const subcommands: Record<string, ReadonlySet<string>> = {};
    for (const [head, subs] of Object.entries(policy.subcommands ?? {})) {
        subcommands[head] = new Set(subs);
    }
    return {
        dangerousHeads: new Set([...(policy.dangerousHeads ?? []), ...HARD_DANGEROUS_HEADS]),
        readonlyHeads: new Set(policy.readonlyHeads ?? []),
        networkHeads: new Set(policy.networkHeads ?? []),
        subcommands,
    };
}

const TOKEN_SPLIT = /[\s;|&()<>]+/;
const HEAD_SPLIT = /\s+/;
const SHELL_META = /[;&|<>\x60]|\$\(|\$\{|\n|\r/;

function basename(token: string): string {
    const parts = token.split('/');
    return parts[parts.length - 1] ?? token;
}

export function hasShellMeta(command: string): boolean {
    return SHELL_META.test(command);
}

export function commandHead(command: string): string | undefined {
    const first = command.trim().split(HEAD_SPLIT)[0];
    if (first === undefined || first.length === 0) return undefined;
    return basename(first);
}

function subcommandOf(tokens: readonly string[]): string | undefined {
    const second = tokens[1];
    if (second === undefined || second.startsWith('-')) return undefined;
    return basename(second);
}

function isDangerousToken(token: string, next: string | undefined, rules: CommandRules): boolean {
    const head = basename(token);
    if (rules.dangerousHeads.has(head)) return true;
    const subRules = rules.subcommands[head];
    if (subRules !== undefined) {
        if (next === undefined) return true;
        return !subRules.has(basename(next));
    }
    return false;
}

export function classifyCommand(
    command: string,
    rules: CommandRules = compileCommandPolicy(),
): CommandClass {
    const trimmed = command.trim();
    if (trimmed.length === 0) return 'unknown';
    const tokens = trimmed.split(TOKEN_SPLIT).filter((token) => token.length > 0);
    if (tokens.some((token, index) => isDangerousToken(token, tokens[index + 1], rules))) {
        return 'dangerous';
    }
    const head = commandHead(trimmed);
    if (head === undefined) return 'unknown';
    const subRules = rules.subcommands[head];
    if (subRules !== undefined) {
        const sub = subcommandOf(tokens);
        if (sub !== undefined && subRules.has(sub) && !hasShellMeta(trimmed)) return 'readonly';
        const second = tokens[1];
        if (
            (second === '--version' || second === '--help' || second === '-v' || second === '-h') &&
            !hasShellMeta(trimmed)
        ) {
            return 'readonly';
        }
        // 只读子命令白名单之外（含未知子命令）保守归 dangerous。
        return 'dangerous';
    }
    if (rules.readonlyHeads.has(head) && !hasShellMeta(trimmed)) return 'readonly';
    if (rules.networkHeads.has(head)) return 'network';
    return 'unknown';
}

/** 该命令是否属于出网命令（shell.run 需走出站账本裁决）。 */
export function isNetworkCommand(
    command: string,
    rules: CommandRules = compileCommandPolicy(),
): boolean {
    const head = commandHead(command);
    return head !== undefined && rules.networkHeads.has(head);
}

export interface ApprovalTarget {
    /** 授权 key。 */
    key: string;
    /** true = 永远逐次审批（不查/不存 session/workspace 预授权）。 */
    alwaysPrompt: boolean;
    /** 允许的作用域（供 UI 隐藏不可用按钮）。 */
    allowedScopes: readonly ApprovalScope[];
}

const ALL_SCOPES: readonly ApprovalScope[] = ['once', 'session', 'workspace'];
const ONCE_ONLY: readonly ApprovalScope[] = ['once'];

/** 计算一次调用的审批目标（key + 是否逐次 + 可用作用域）。 */
export function approvalTargetOf(
    registration: ToolRegistration,
    projection: ValueProjection,
    rules: CommandRules = compileCommandPolicy(),
): ApprovalTarget {
    if (projection.command !== undefined) {
        const command = projection.command.trim().replace(/\s+/g, ' ');
        const commandClass = classifyCommand(command, rules);
        if (commandClass === 'dangerous') {
            return {
                key: `${registration.name}:cmd:${command}`,
                alwaysPrompt: true,
                allowedScopes: ONCE_ONLY,
            };
        }
        if (commandClass === 'readonly') {
            const head = commandHead(command) ?? command;
            return {
                key: `${registration.name}:cmdname:${head}`,
                alwaysPrompt: false,
                allowedScopes: ALL_SCOPES,
            };
        }
        return {
            key: `${registration.name}:cmd:${command}`,
            alwaysPrompt: false,
            allowedScopes: ALL_SCOPES,
        };
    }
    return {
        key: `${registration.name}:obs:${stableStringify(projection)}`,
        alwaysPrompt: false,
        allowedScopes: ALL_SCOPES,
    };
}
