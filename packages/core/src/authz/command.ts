/**
 * Shell 命令分类与审批目标（approval target）。
 *
 * 审批粒度按命令类别决定：
 * - dangerous：不可撤回 / 提权 / 写系统 / 任意执行类命令，永远逐次审批（tier 下限，不受“完全”档放宽）；
 * - readonly：只读命令（含多子命令工具的只读子命令）且无 shell 元字符，放宽为“命令名”粒度；
 * - network：curl/wget 等出网命令，交由出站账本裁决（clean 放行 / 有敏感读则转审批），不一律逐次；
 * - unknown：其余命令，按完整命令行粒度。
 *
 * 判定保守：命令任意位置出现高危词（按 ; | & 拆分后的 token）即 dangerous；
 * 多子命令工具（git/docker/npm…）只有白名单子命令算只读，其余（含未知子命令）一律 dangerous。
 */

import type { ApprovalScope, ToolRegistration } from './gateway-types.js';
import { stableStringify } from './hash.js';
import type { ValueProjection } from './types.js';

export type CommandClass = 'dangerous' | 'readonly' | 'network' | 'unknown';

/** 高危命令词：不可撤回、提权、写系统、可执行任意逻辑。 */
const DANGEROUS_HEADS: ReadonlySet<string> = new Set([
    'rm',
    'rmdir',
    'shred',
    'dd',
    'mkfs',
    'fdisk',
    'mkswap',
    'truncate',
    'chmod',
    'chown',
    'chgrp',
    'mount',
    'umount',
    'sudo',
    'su',
    'doas',
    'shutdown',
    'reboot',
    'halt',
    'kill',
    'pkill',
    'killall',
    'mv',
    'cp',
    'install',
    'rsync',
    'tee',
    'apt',
    'apt-get',
    'yum',
    'dnf',
    'apk',
    'brew',
    'make',
    'terraform',
    'ansible',
    'ssh',
    'scp',
    'sftp',
    'telnet',
    'nc',
    'ncat',
    'netcat',
    'bash',
    'sh',
    'zsh',
    'fish',
    'eval',
    'exec',
    'source',
    'xargs',
    'find',
    'service',
    'launchctl',
]);

/** 不出网、不落盘、不提权的信息类命令：无 shell 元字符时可放宽为命令名粒度。 */
const READONLY_HEADS: ReadonlySet<string> = new Set([
    'ping',
    'ping6',
    'traceroute',
    'tracepath',
    'mtr',
    'dig',
    'nslookup',
    'host',
    'netstat',
    'ss',
    'lsof',
    'ps',
    'top',
    'free',
    'df',
    'du',
    'uptime',
    'uname',
    'hostname',
    'whoami',
    'id',
    'groups',
    'date',
    'cal',
    'pwd',
    'ls',
    'which',
    'whereis',
    'type',
    'command',
    'echo',
    'printf',
    'true',
    'false',
    'test',
    'sleep',
    'bc',
]);

/** 出网命令：由出站账本（机制三）裁决，不一律逐次审批。 */
const NETWORK_HEADS: ReadonlySet<string> = new Set(['curl', 'wget']);

/** 多子命令工具：仅列出的子命令算只读；未列出/未知子命令一律 dangerous（保守默认）。 */
const SUBCOMMAND_RULES: Readonly<Record<string, ReadonlySet<string>>> = {
    git: new Set([
        'status',
        'log',
        'diff',
        'show',
        'rev-parse',
        'describe',
        'blame',
        'shortlog',
        'whatchanged',
        'ls-files',
        'ls-remote',
        'grep',
        'fetch',
        'cat-file',
        'rev-list',
        'name-rev',
        'count-objects',
        'verify-pack',
        'fsck',
        'help',
        'version',
    ]),
    docker: new Set([
        'ps',
        'images',
        'inspect',
        'logs',
        'version',
        'info',
        'stats',
        'top',
        'port',
        'history',
        'diff',
        'search',
        'events',
        'help',
    ]),
    podman: new Set([
        'ps',
        'images',
        'inspect',
        'logs',
        'version',
        'info',
        'stats',
        'top',
        'port',
        'history',
        'diff',
        'search',
        'events',
        'help',
    ]),
    kubectl: new Set([
        'get',
        'describe',
        'logs',
        'top',
        'explain',
        'version',
        'api-resources',
        'api-versions',
        'config',
        'cluster-info',
        'auth',
        'help',
    ]),
    systemctl: new Set([
        'status',
        'list-units',
        'list-unit-files',
        'is-active',
        'is-enabled',
        'is-failed',
        'show',
        'cat',
        'help',
    ]),
    npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'ping', 'help', 'version']),
    pnpm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'ping', 'help', 'version']),
    yarn: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'ping', 'help', 'version']),
    pip: new Set(['list', 'show', 'freeze', 'check', 'help', 'version']),
    pip3: new Set(['list', 'show', 'freeze', 'check', 'help', 'version']),
    go: new Set(['version', 'env', 'list', 'doc', 'help']),
    cargo: new Set(['version', 'metadata', 'tree', 'search', 'help']),
};

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

function isDangerousToken(token: string, next: string | undefined): boolean {
    const head = basename(token);
    if (DANGEROUS_HEADS.has(head)) return true;
    const rule = SUBCOMMAND_RULES[head];
    if (rule !== undefined) {
        if (next === undefined) return true;
        return !rule.has(basename(next));
    }
    return false;
}

export function classifyCommand(command: string): CommandClass {
    const trimmed = command.trim();
    if (trimmed.length === 0) return 'unknown';
    const tokens = trimmed.split(TOKEN_SPLIT).filter((token) => token.length > 0);
    if (tokens.some((token, index) => isDangerousToken(token, tokens[index + 1]))) {
        return 'dangerous';
    }
    const head = commandHead(trimmed);
    if (head === undefined) return 'unknown';
    const rule = SUBCOMMAND_RULES[head];
    if (rule !== undefined) {
        const sub = subcommandOf(tokens);
        if (sub !== undefined && rule.has(sub) && !hasShellMeta(trimmed)) return 'readonly';
        const second = tokens[1];
        if (
            (second === '--version' || second === '--help' || second === '-v' || second === '-h') &&
            !hasShellMeta(trimmed)
        ) {
            return 'readonly';
        }
        return 'unknown';
    }
    if (READONLY_HEADS.has(head) && !hasShellMeta(trimmed)) return 'readonly';
    if (NETWORK_HEADS.has(head)) return 'network';
    return 'unknown';
}

/** 该命令是否属于出网命令（shell.run 需走出站账本裁决）。 */
export function isNetworkCommand(command: string): boolean {
    const head = commandHead(command);
    return head !== undefined && NETWORK_HEADS.has(head);
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
): ApprovalTarget {
    if (projection.command !== undefined) {
        const command = projection.command.trim().replace(/\s+/g, ' ');
        const commandClass = classifyCommand(command);
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
