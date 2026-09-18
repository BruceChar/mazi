/**
 * Auth 命令策略：内置默认规则 + 配置加载（自说明模板 + 严格校验）。
 *
 * 规则**数据化**：命令清单放配置（默认 <MAZI_HOME>/config/auth/commands.json，可用
 * MAZI_AUTH_CONFIG_DIR 覆盖），代码只保留与具体命令无关的硬条件（见 core authz/command.ts）。
 *
 * subcommands 规则：多子命令工具（git/docker/npm…）——只有 readonly 数组里列出的子命令算只读；
 * 其余（包括未知子命令）一律 dangerous、逐次审批。未命中任何规则的命令 → unknown，正常走 shell.run。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { authz } from '@mazi/core';

export const AUTH_COMMAND_POLICY_FILE = 'commands.json';
export const AUTH_COMMAND_POLICY_SCHEMA_FILE = 'commands.schema.json';
export const AUTH_COMMAND_POLICY_VERSION = 1;

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

/** 生成给编辑器看的 JSON Schema（写入 schema 文件，供配置自说明/校验）。 */
export const AUTH_COMMAND_POLICY_SCHEMA: Record<string, unknown> = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Mazi auth command policy',
    type: 'object',
    additionalProperties: true,
    properties: {
        $schema: { type: 'string' },
        version: { type: 'integer', const: AUTH_COMMAND_POLICY_VERSION },
        _doc: { type: 'object', description: '字段说明（自说明用，加载时忽略）' },
        dangerousHeads: {
            type: 'array',
            items: { type: 'string' },
            description: '高危命令：永远逐次人工审批，不受档位/预授权放宽。',
        },
        readonlyHeads: {
            type: 'array',
            items: { type: 'string' },
            description: '只读命令：无 shell 元字符时放宽为“命令名”粒度。',
        },
        networkHeads: {
            type: 'array',
            items: { type: 'string' },
            description: '出网命令：交出站账本裁决（干净放行，含敏感读转审批）。',
        },
        subcommands: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
            description:
                '多子命令工具：只有列出的子命令算只读，其余（含未知子命令）一律 dangerous、逐次审批。',
        },
    },
};

const POLICY_DOC = {
    dangerousHeads: '高危命令：永远逐次人工审批，不受档位/预授权放宽。',
    readonlyHeads: '只读命令：无 shell 元字符时放宽为命令名粒度（批准 ping 覆盖所有 ping）。',
    networkHeads: '出网命令：交出站账本裁决（账本干净放行，含敏感读则转审批）。',
    subcommands:
        '多子命令工具：只有数组里列出的子命令算只读，其余（含未知子命令）一律 dangerous、逐次审批。',
    _rules: '未命中任何规则的命令按 shell.run 默认（unknown，完整命令行 key）处理；解释器/提权命令（sh/bash/sudo…）与 shell 元字符是代码硬条件，不可放宽。',
};

/** 默认配置模板（带 $schema/version/_doc，自说明）。 */
export function renderDefaultCommandPolicy(): string {
    return `${JSON.stringify(
        {
            $schema: `./${AUTH_COMMAND_POLICY_SCHEMA_FILE}`,
            version: AUTH_COMMAND_POLICY_VERSION,
            _doc: POLICY_DOC,
            ...DEFAULT_COMMAND_POLICY,
        },
        null,
        2,
    )}\n`;
}

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

/** 宽松解析（加载用）：忽略非法字段；用于读文件容错。 */
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

export interface CommandPolicyValidation {
    ok: boolean;
    policy?: authz.CommandPolicy;
    error?: string;
}

/** 严格校验（保存用）：已知字段类型不对即报错，避免手误静默失效。 */
export function validateCommandPolicy(raw: unknown): CommandPolicyValidation {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '顶层必须是 JSON 对象' };
    }
    const obj = raw as Record<string, unknown>;
    const policy: authz.CommandPolicy = {};
    for (const key of ['dangerousHeads', 'readonlyHeads', 'networkHeads'] as const) {
        const value = obj[key];
        if (value === undefined) continue;
        if (!isStringArray(value)) return { ok: false, error: `${key} 必须是字符串数组` };
        policy[key] = value;
    }
    if (obj.subcommands !== undefined) {
        if (
            obj.subcommands === null ||
            typeof obj.subcommands !== 'object' ||
            Array.isArray(obj.subcommands)
        ) {
            return { ok: false, error: 'subcommands 必须是 { 工具名: 字符串数组 }' };
        }
        const subcommands: Record<string, string[]> = {};
        for (const [head, subs] of Object.entries(obj.subcommands as Record<string, unknown>)) {
            if (!isStringArray(subs)) {
                return { ok: false, error: `subcommands.${head} 必须是字符串数组` };
            }
            subcommands[head] = subs;
        }
        policy.subcommands = subcommands;
    }
    return { ok: true, policy };
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

/** 首次部署写入默认模板 + schema（仅当文件不存在）；由应用引导调用，测试不触发。 */
export function writeDefaultCommandPolicy(filePath: string): void {
    try {
        if (!existsSync(filePath)) {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(filePath, renderDefaultCommandPolicy(), 'utf8');
        }
        const schemaPath = join(dirname(filePath), AUTH_COMMAND_POLICY_SCHEMA_FILE);
        if (!existsSync(schemaPath)) {
            writeFileSync(
                schemaPath,
                `${JSON.stringify(AUTH_COMMAND_POLICY_SCHEMA, null, 2)}\n`,
                'utf8',
            );
        }
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
