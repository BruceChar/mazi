/**
 * Shell 命令分类与审批目标（approval target）。
 *
 * 审批粒度按命令类别决定，而不是统一按完整命令行、也不统一按能力类目：
 * - dangerous：不可撤回 / 提权 / 写系统 / 任意执行类命令，永远逐次审批，不接受 session/workspace 预授权；
 * - readonly：只读命令且不含 shell 元字符，可放宽为“命令名”粒度（批准 ping 即放行所有 ping）；
 * - unknown：其余命令，按完整命令行粒度（同一条命令可复用 session/workspace 授权）。
 *
 * 判定保守：命令中任何位置出现高危命令词（按 ; | & 等拆分后的 token）即视为 dangerous；
 * 只读放宽仅在无元字符时生效，避免 "ping x; rm -rf /" 被放宽。
 */

import type { ApprovalScope, ToolRegistration } from './gateway-types.js';
import { stableStringify } from './hash.js';
import type { ValueProjection } from './types.js';

export type CommandClass = 'dangerous' | 'readonly' | 'unknown';

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
    'systemctl',
    'service',
    'launchctl',
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
    'pip',
    'pip3',
    'npm',
    'pnpm',
    'yarn',
    'cargo',
    'go',
    'git',
    'docker',
    'podman',
    'kubectl',
    'terraform',
    'ansible',
    'make',
    'curl',
    'wget',
    'nc',
    'ncat',
    'netcat',
    'ssh',
    'scp',
    'sftp',
    'telnet',
    'bash',
    'sh',
    'zsh',
    'fish',
    'eval',
    'exec',
    'source',
    'xargs',
    'find',
]);

/** 只读命令词：无 shell 元字符时可放宽为命令名粒度。 */
const READONLY_HEADS: ReadonlySet<string> = new Set([
    // 仅收录“不读取文件内容、不落盘、不提权”的连通性/信息类命令，
    // 避免把 cat/grep/env 这类可读取秘密或环境变量的命令放宽。
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

export function classifyCommand(command: string): CommandClass {
    const trimmed = command.trim();
    if (trimmed.length === 0) return 'unknown';
    const tokens = trimmed.split(TOKEN_SPLIT).filter((token) => token.length > 0);
    if (tokens.some((token) => DANGEROUS_HEADS.has(basename(token)))) return 'dangerous';
    const head = commandHead(trimmed);
    if (head !== undefined && READONLY_HEADS.has(head) && !hasShellMeta(trimmed)) return 'readonly';
    return 'unknown';
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
