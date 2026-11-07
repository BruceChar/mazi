/**
 * Shell 命令分类与审批目标（approval target）。
 *
 * 规则**数据化**：命令清单来自 CommandPolicy（运行时从 ~/.mazi/config/auth 加载），
 * 代码里只保留与具体命令无关的硬条件：
 * - shell 元字符（分号/管道/重定向/反引号/$ 展开/换行）→ 不得放宽为只读；
 * - 解释器/提权命令（sh/bash/zsh/fish/eval/exec/source/sudo/su/doas）恒为 dangerous；
 * - 多子命令工具未列出的子命令通常为 dangerous；包管理器的
 *   test/build/run/install 属于工作区写常态，按 unknown 自动执行；
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
    /** 多子命令工具：只读白名单；git/docker 等未列出子命令仍 dangerous。 */
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
    for (const token of tokens.slice(1)) {
        if (token.startsWith('-')) continue;
        return basename(token);
    }
    return undefined;
}

/** 包管理器的 test/build/run 等不在只读白名单，但属于工作区写档的常规任务。 */
const WORKSPACE_PACKAGE_HEADS: ReadonlySet<string> = new Set([
    'npm',
    'pnpm',
    'yarn',
    'pip',
    'pip3',
]);

function isDangerousToken(
    tokens: readonly string[],
    index: number,
    rules: CommandRules,
): boolean {
    const token = tokens[index] ?? '';
    const head = basename(token);
    // find/xargs 常被用于只读分析，不能仅凭命令名判危险。
    // find 的破坏动作由参数识别；xargs 的真正风险由其后被调用命令的 head 识别。
    if (head === 'find') {
        return tokens
            .slice(index + 1)
            .some((item) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(item));
    }
    if (head === 'xargs') return false;
    if (rules.dangerousHeads.has(head)) return true;
    const subRules = rules.subcommands[head];
    if (subRules !== undefined) {
        const subcommand = subcommandOf(tokens.slice(index));
        if (subcommand === undefined) return !WORKSPACE_PACKAGE_HEADS.has(head);
        return !subRules.has(subcommand) && !WORKSPACE_PACKAGE_HEADS.has(head);
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
    if (tokens.some((_token, index) => isDangerousToken(tokens, index, rules))) {
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
        // 包管理器未知子命令（test/build/run）属于工作区写常态；
        // git/docker 等仍保守逐次审批。
        return WORKSPACE_PACKAGE_HEADS.has(head) ? 'unknown' : 'dangerous';
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
