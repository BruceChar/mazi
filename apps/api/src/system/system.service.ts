import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SystemVersionRef, SystemVersionView } from '@mazi/libs';
import { Injectable } from '@nestjs/common';

/** git 调用超时（毫秒）：卡住的 git 不得拖垮 /api/system/info。 */
const GIT_TIMEOUT_MS = 2000;
/** 从当前文件向上找 .git 的最大层数（monorepo 内 apps/api/dist → 仓库根 ≤ 6 层）。 */
const MAX_ROOT_LEVELS = 6;

/** 注入缝：git/fs 默认走真实实现，单测注入假实现（无需 git 与磁盘）。 */
export interface SystemServiceOptions {
    /** 执行 `git <args>` 并返回 stdout（已 trim）；失败应抛错。 */
    exec?: (command: string, args: readonly string[]) => string;
    /** 读取文本文件（默认 readFileSync utf8）。 */
    readFile?: (path: string) => string;
    /** 仓库根；缺省从 import.meta.dirname 向上探测 .git。 */
    root?: string;
}

function defaultExec(command: string, args: readonly string[]): string {
    return execFileSync(command, [...args], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        stdio: 'pipe',
    }).trim();
}

function defaultReadFile(path: string): string {
    return readFileSync(path, 'utf8');
}

/** 向上探测含 .git 的仓库根；超过层数/到文件系统根则 undefined（无 git 场景）。 */
function findRepoRoot(start: string): string | undefined {
    let dir = start;
    for (let level = 0; level < MAX_ROOT_LEVELS; level += 1) {
        if (existsSync(join(dir, '.git'))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

/**
 * SystemService：系统版本与构建信息的唯一读取点（docs/web/迭代面板设计.md §2.2 / §4）。
 * 所有 git/fs 失败都降级为空字段 + packageVersion 回落，**绝不抛错**（面板只读展示）。
 * 迭代记录的 base/applied 快照也由本服务提供（runtime 不读 git）。
 */
@Injectable()
export class SystemService {
    private readonly exec: NonNullable<SystemServiceOptions['exec']>;
    private readonly readFile: NonNullable<SystemServiceOptions['readFile']>;
    private readonly rootOption?: string;

    constructor(options: SystemServiceOptions = {}) {
        this.exec = options.exec ?? defaultExec;
        this.readFile = options.readFile ?? defaultReadFile;
        this.rootOption = options.root;
    }

    /** GET /api/system/info 的完整视图。 */
    info(): SystemVersionView {
        const root = this.repoRoot();
        const packageVersion = this.packageVersion(root);
        return {
            ...this.readRef(root, packageVersion),
            commitSubject: this.git(root, ['log', '-1', '--format=%s']),
            commitDate: this.git(root, ['log', '-1', '--format=%cI']),
            packageVersion,
            node: process.version,
            platform: `${process.platform} ${process.arch}`,
            readAt: Date.now(),
        };
    }

    /** 轻量版本快照（迭代记录 base/applied 注入用）。 */
    readVersion(): SystemVersionRef {
        const root = this.repoRoot();
        return this.readRef(root, this.packageVersion(root));
    }

    private readRef(root: string | undefined, packageVersion: string): SystemVersionRef {
        if (root === undefined) {
            return { version: packageVersion, commit: '', branch: '', dirty: false };
        }
        return {
            version:
                this.git(root, ['describe', '--tags', '--always', '--dirty']) || packageVersion,
            commit: this.git(root, ['rev-parse', '--short', 'HEAD']),
            branch: this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
            dirty: this.git(root, ['status', '--porcelain']).length > 0,
        };
    }

    /** 仓库根（显式注入优先；否则探测）。 */
    private repoRoot(): string | undefined {
        return this.rootOption ?? findRepoRoot(import.meta.dirname);
    }

    /** 单条 git 读取：任何失败降级为空串（面板展示不因 VCS 状态中断）。 */
    private git(root: string | undefined, args: string[]): string {
        if (root === undefined) return '';
        try {
            return this.exec('git', ['-C', root, ...args]);
        } catch {
            return '';
        }
    }

    /** 根 package.json 的 version；读取/解析失败降级为空串。 */
    private packageVersion(root: string | undefined): string {
        if (root === undefined) return '';
        try {
            const parsed = JSON.parse(this.readFile(join(root, 'package.json'))) as {
                version?: unknown;
            };
            return typeof parsed.version === 'string' ? parsed.version : '';
        } catch {
            return '';
        }
    }
}
