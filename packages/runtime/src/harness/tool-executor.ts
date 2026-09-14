import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { resolve, sep } from 'node:path';
import { detectPackageManager } from './system-probe.js';
import { CliCommandSpec } from '../config.js';
import { readFileSync } from 'node:fs';


/** 自动安装缺失命令（brew/apt/dnf/apk），返回是否成功 */
async function installCliTool(spec: CliCommandSpec): Promise<{ ok: boolean; error?: string }> {
    const manager = spec.installManager ?? (await detectPackageManager());
    if (!manager) {
        return { ok: false, error: 'no package manager found (brew/apt-get/dnf/apk)' };
    }
    const pkg = spec.installPackage ?? spec.bin;
    const args =
        manager === 'brew'
            ? ['install', '-q', pkg]
            : manager === 'apt-get'
              ? ['install', '-y', pkg]
              : manager === 'dnf'
                ? ['install', '-y', pkg]
                : ['add', pkg];
    try {
        await promisify(execFile)(manager, args, { timeout: 300_000 });
        return { ok: true };
    } catch (error) {
        const err = error as { stderr?: string; message?: string };
        return {
            ok: false,
            error: `${manager} install ${pkg} failed: ${String(err.stderr ?? err.message ?? error)
                .trim()
                .slice(0, 300)}`,
        };
    }
}
export function fsReadToolImpl(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: unknown; error?: string; retryable?: boolean }> {
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!path) {
        return Promise.resolve({ ok: false, error: '缺少 path 参数' });
    }
    const absolutePath = resolve(workspaceRoot ?? process.cwd(), path);
    if (workspaceRoot && !absolutePath.startsWith(resolve(workspaceRoot))) {
        return Promise.resolve({
            ok: false,
            error: 'path 超出当前工作区权限范围',
            retryable: false,
        });
    }
    try {
        const content = readFileSync(absolutePath, 'utf8');
        return Promise.resolve({ ok: true, content });
    } catch (error) {
        return Promise.resolve({ ok: false, error: (error as Error).message, retryable: false });
    }
}

/** CLI 工具执行：workspace 内以 argv 运行（不经 shell），输出截断防爆 */

export async function runCliTool(
    spec: CliCommandSpec,
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const rootAbs = resolve(workspaceRoot ?? process.cwd());
    const argv: string[] = [];
    for (const token of spec.args) {
        const required = token.match(/^\{(\w+)\}$/);
        const optional = token.match(/^\{(\w+)\?\}$/);
        if (required !== null || optional !== null) {
            const key = (required ?? optional)?.[1] ?? '';
            const value = args[key];
            if (value === undefined || value === null || value === '') {
                if (required !== null) {
                    return { ok: false, error: `缺少参数：${key}` };
                }
                continue;
            }
            if (key === 'path') {
                // 路径必须落在工作区内（防越界读写）
                const target = resolve(rootAbs, String(value));
                const inside = target === rootAbs || target.startsWith(rootAbs + sep);
                if (!inside) {
                    return { ok: false, error: `path escapes the workspace: ${String(value)}` };
                }
            }
            // 数组值展开为多个 argv（如 git status --short）
            if (Array.isArray(value)) {
                for (const item of value) {
                    const part = String(item ?? '');
                    if (part.length > 0) {
                        argv.push(part);
                    }
                }
            } else {
                argv.push(String(value));
            }
            continue;
        }
        argv.push(token);
    }
    const maxChars = spec.maxOutputChars ?? 40_000;
    try {
        const { stdout } = await promisify(execFile)(spec.bin, argv, {
            cwd: rootAbs,
            timeout: spec.timeoutMs ?? 60_000,
            maxBuffer: 8 * 1_048_576,
            encoding: 'utf8',
        });
        const text = String(stdout ?? '').trim();
        if (text.length > maxChars) {
            return { ok: true, content: `${text.slice(0, maxChars)}\n…（输出已截断）` };
        }
        return { ok: true, content: text };
    } catch (error) {
        const err = error as { code?: string; stderr?: string; message?: string };
        if (err.code === 'ENOENT') {
            // 自动安装缺失命令后重试一次
            const installed = await installCliTool(spec);
            if (!installed.ok) {
                return {
                    ok: false,
                    error: `${spec.bin} is missing and auto-install failed: ${installed.error}`,
                };
            }
            try {
                const { stdout } = await promisify(execFile)(spec.bin, argv, {
                    cwd: rootAbs,
                    timeout: spec.timeoutMs ?? 30_000,
                    maxBuffer: 1_048_576,
                    encoding: 'utf8',
                });
                const text = String(stdout ?? '').trim();
                return {
                    ok: true,
                    content:
                        text.length > maxChars
                            ? `${text.slice(0, maxChars)}\n…（output truncated）`
                            : text,
                };
            } catch (retryError) {
                const retryErr = retryError as { code?: string; stderr?: string; message?: string };
                if (retryErr.code === 'ENOENT') {
                    return {
                        ok: false,
                        error: `${spec.bin} still missing after install (${spec.installPackage ?? spec.bin})`,
                    };
                }
                const stderr = String(retryErr.stderr ?? '').trim();
                return { ok: false, error: stderr || String(retryErr.message ?? retryError) };
            }
        }
        const stderr = String(err.stderr ?? '').trim();
        return { ok: false, error: stderr.slice(0, 2000) || String(err.message ?? error) };
    }
}

/**
 * 通用脚本/命令执行：bash -lc，cwd = workspace（缺省进程 cwd）。
 * 支持 node / npm / pnpm / python / bash 及任意 *.sh/*.js/*.ts/*.py；输出截断。
 */
export async function runShellTool(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) {
        return { ok: false, error: '缺少 command' };
    }
    const requested = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
        ? Math.min(600_000, Math.max(1_000, requested))
        : 120_000;
    const cwd = resolve(workspaceRoot ?? process.cwd());
    const MAX = 60_000;
    try {
        const { stdout, stderr } = await promisify(execFile)('bash', ['-lc', command], {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 16 * 1_048_576,
            encoding: 'utf8',
        });
        const stderrText = String(stderr ?? '').trim();
        const merged = (
            String(stdout ?? '') + (stderrText ? `\n[stderr]\n${stderrText}` : '')
        ).trim();
        const content = merged.length > 0 ? merged : '(no output)';
        return {
            ok: true,
            content: content.length > MAX ? `${content.slice(0, MAX)}\n…（输出已截断）` : content,
        };
    } catch (error) {
        const err = error as {
            killed?: boolean;
            code?: number | string;
            signal?: string;
            stdout?: string;
            stderr?: string;
            message?: string;
        };
        const head: string[] = [];
        if (err.killed) head.push(`command timed out after ${timeoutMs}ms`);
        if (typeof err.code === 'number') head.push(`exit code ${err.code}`);
        if (err.signal) head.push(`signal ${err.signal}`);
        const detail = [String(err.stdout ?? '').trim(), String(err.stderr ?? '').trim()]
            .filter(Boolean)
            .join('\n');
        const message = [head.join(', '), detail].filter(Boolean).join('\n').slice(0, 2000);
        return { ok: false, error: message || String(err.message ?? error) };
    }
}
