/**
 * condition-environment —— 机械验收条款的宿主环境探针（Node 实现）。
 *
 * 契约评估器（gts/acceptance）保持纯函数：文件/git 事实通过本探针注入。
 * 所有路径都解析到 workspace 内，越界路径一律视为不存在（fail-closed）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import type { ConditionEnvironment } from '../gts/acceptance.js';

/** 解析 workspace 内的相对路径；绝对路径、.. 越界或缺根都返回 undefined。 */
function resolveInside(root: string | undefined, path: string): string | undefined {
    if (root === undefined || path.length === 0) return undefined;
    const abs = resolve(root, path);
    if (abs !== root && !abs.startsWith(root + sep)) return undefined;
    return abs;
}

function safeReadFile(file: string | undefined): string | null {
    if (file === undefined) return null;
    try {
        if (!statSync(file).isFile()) return null;
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/**
 * 构造条件环境。root 用 getter 传入：HarnessRuntime 在构造 verifier 之后才赋值
 * workspaceRoot，校验发生在每次 verify 时，因此这里延迟读取即可。
 */
export function createConditionEnvironment(
    workspaceRoot: () => string | undefined,
): ConditionEnvironment {
    const root = (): string | undefined => {
        try {
            return workspaceRoot();
        } catch {
            return undefined;
        }
    };
    return {
        fileExists(path: string): boolean {
            const file = resolveInside(root(), path);
            return file !== undefined && existsSync(file);
        },
        readFile(path: string): string | null {
            return safeReadFile(resolveInside(root(), path));
        },
        gitHasCommit(): boolean {
            const cwd = root();
            if (cwd === undefined) return false;
            try {
                execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
                    cwd,
                    timeout: 2_000,
                    stdio: 'ignore',
                });
                return true;
            } catch {
                return false;
            }
        },
    };
}
