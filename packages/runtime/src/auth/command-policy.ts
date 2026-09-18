/**
 * Auth 命令策略：内置默认规则 + 文件加载。
 *
 * 规则**数据化**：命令清单放配置（默认 <MAZI_HOME>/config/auth/commands.json，可用
 * MAZI_AUTH_CONFIG_DIR 覆盖），代码只保留与具体命令无关的硬条件（见 core authz/command.ts）。
 * 文件缺失时会写入一份默认模板便于查看/编辑；后续可替换为 DB/后台管理实现（同一 load 契约）。
 *
 * 未命中任何规则的命令 → core 归类为 unknown，正常走 shell.run。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { authz } from '@mazi/core';

export const AUTH_COMMAND_POLICY_FILE = 'commands.json';

/**
 * 默认命令规则（运营/后台可整段或按键覆盖）。
 * 解释器/提权命令（sh/bash/sudo…）是代码硬条件，不在此列也不可放宽。
 */
export const DEFAULT_COMMAND_POLICY: authz.CommandPolicy = {
    dangerousHeads: [
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
        'xargs',
        'find',
        'service',
        'launchctl',
    ],
    readonlyHeads: [
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
    ],
    networkHeads: ['curl', 'wget'],
    subcommands: {
        git: [
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
        ],
        docker: [
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
        ],
        podman: [
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
        ],
        kubectl: [
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
        ],
        systemctl: [
            'status',
            'list-units',
            'list-unit-files',
            'is-active',
            'is-enabled',
            'is-failed',
            'show',
            'cat',
            'help',
        ],
        npm: ['ls', 'list', 'view', 'info', 'outdated', 'why', 'ping', 'help', 'version'],
        pnpm: ['ls', 'list', 'view', 'info', 'outdated', 'why', 'ping', 'help', 'version'],
        yarn: ['ls', 'list', 'view', 'info', 'outdated', 'why', 'ping', 'help', 'version'],
        pip: ['list', 'show', 'freeze', 'check', 'help', 'version'],
        pip3: ['list', 'show', 'freeze', 'check', 'help', 'version'],
        go: ['version', 'env', 'list', 'doc', 'help'],
        cargo: ['version', 'metadata', 'tree', 'search', 'help'],
    },
};

export interface AuthPolicyLoadResult {
    policy: authz.CommandPolicy;
    /** 'file' = 已加载配置；'default' = 文件缺失/损坏，使用内置默认。 */
    source: 'file' | 'default';
    path: string;
    error?: string;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 解析配置对象为 CommandPolicy；字段非法则忽略该字段。 */
export function parseCommandPolicy(raw: unknown): authz.CommandPolicy | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    const policy: authz.CommandPolicy = {};
    if (isStringArray(obj.dangerousHeads)) policy.dangerousHeads = obj.dangerousHeads;
    if (isStringArray(obj.readonlyHeads)) policy.readonlyHeads = obj.readonlyHeads;
    if (isStringArray(obj.networkHeads)) policy.networkHeads = obj.networkHeads;
    if (
        obj.subcommands !== null &&
        typeof obj.subcommands === 'object' &&
        !Array.isArray(obj.subcommands)
    ) {
        const subcommands: Record<string, string[]> = {};
        for (const [head, subs] of Object.entries(obj.subcommands as Record<string, unknown>)) {
            if (isStringArray(subs)) subcommands[head] = subs;
        }
        policy.subcommands = subcommands;
    }
    return policy;
}

/** 合并：override 的数组整段替换；subcommands 按 key 替换（缺省用 base）。 */
export function mergeCommandPolicy(
    base: authz.CommandPolicy,
    override: authz.CommandPolicy,
): authz.CommandPolicy {
    return {
        dangerousHeads: override.dangerousHeads ?? base.dangerousHeads,
        readonlyHeads: override.readonlyHeads ?? base.readonlyHeads,
        networkHeads: override.networkHeads ?? base.networkHeads,
        subcommands: { ...(base.subcommands ?? {}), ...(override.subcommands ?? {}) },
    };
}

/** 首次部署时写入默认模板（仅当文件不存在）；由应用引导调用，测试不触发。 */
export function writeDefaultCommandPolicy(filePath: string): void {
    if (existsSync(filePath)) return;
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, `${JSON.stringify(DEFAULT_COMMAND_POLICY, null, 2)}\n`, 'utf8');
    } catch {
        // 只读文件系统等场景：写模板失败不影响用内置默认运行。
    }
}

/** 加载命令策略；文件缺失/损坏时回退内置默认（不写文件）。 */
export function loadCommandPolicy(filePath: string): AuthPolicyLoadResult {
    try {
        if (!existsSync(filePath)) {
            return { policy: DEFAULT_COMMAND_POLICY, source: 'default', path: filePath };
        }
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
        const parsed = parseCommandPolicy(raw);
        if (parsed === undefined) {
            return {
                policy: DEFAULT_COMMAND_POLICY,
                source: 'default',
                path: filePath,
                error: '配置格式非法，已回退默认',
            };
        }
        return {
            policy: mergeCommandPolicy(DEFAULT_COMMAND_POLICY, parsed),
            source: 'file',
            path: filePath,
        };
    } catch (error) {
        return {
            policy: DEFAULT_COMMAND_POLICY,
            source: 'default',
            path: filePath,
            error: String(error),
        };
    }
}
