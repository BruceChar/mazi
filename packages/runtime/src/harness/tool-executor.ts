import { execFile } from 'child_process';
import { promisify } from 'node:util';
import { resolve, sep } from 'node:path';
import { detectPackageManager } from './system-probe.js';
import { CliCommandSpec } from '../config.js';
import { stat, readFile, access, realpath } from 'node:fs/promises';
// import { type ToolCallResult } from '../config.js';
import { ToolResult } from '@mazi/core';

const execFileAsync = promisify(execFile);

/**
 * Automatically installs missing CLI tools (brew/apt/dnf/apk).
 * Note: This function relies on `spec` being trusted. Do not pass untrusted input to `spec.bin` or `spec.installPackage`.
 *
 * @param spec - The command specification containing installation details.
 * @returns An object indicating success and potential error messages.
 */
async function installCliTool(spec: CliCommandSpec): Promise<{ ok: boolean; error?: string }> {
    const manager = spec.installManager ?? (await detectPackageManager());
    if (!manager) {
        return { ok: false, error: 'No package manager found (brew/apt-get/dnf/apk)' };
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
        await execFileAsync(manager, args, { timeout: 300_000 });
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

/**
 * File reading implementation with security and stability safeguards.
 * 1. Limits file size to prevent OOM.
 * 2. Resolves symbolic links to prevent directory traversal attacks.
 * 3. Uses async I/O to prevent blocking the event loop.
 *
 * @param args - Arguments containing the 'path' to read.
 * @param workspaceRoot - The root directory to constrain file access.
 * @returns File content or an error object.
 */
export async function fsReadToolImpl(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: unknown; error?: string; retryable?: boolean }> {
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!path) {
        return { ok: false, error: 'Missing path parameter' };
    }

    const rootAbs = resolve(workspaceRoot ?? process.cwd());
    const absolutePath = resolve(rootAbs, path);

    try {
        // Safety 1: Prevent OOM by checking file size before reading (Limit: 10MB)
        const stats = await stat(absolutePath);
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        if (stats.size > MAX_FILE_SIZE) {
            return {
                ok: false,
                error: `File too large (${Math.round(stats.size / 1024 / 1024)}MB > 10MB limit)`,
            };
        }

        // Safety 2: Prevent symlink attacks by resolving the real path
        const realPath = await realpath(absolutePath);
        const realRoot = await realpath(rootAbs);

        if (!realPath.startsWith(realRoot + sep) && realPath !== realRoot) {
            return {
                ok: false,
                error: 'Path resolves outside of workspace (symlink restriction)',
                retryable: false,
            };
        }

        // Stability 1: Use async readFile to avoid blocking the event loop
        const content = await readFile(absolutePath, 'utf8');
        return { ok: true, content };
    } catch (error) {
        return { ok: false, error: (error as Error).message, retryable: false };
    }
}

/**
 * Executes a CLI tool with arguments defined in a spec.
 *
 * Security & Robustness features:
 * - Prevents path traversal via argument validation.
 * - Checks for symlink escapes on existing paths.
 * - Handles missing tools via auto-installation.
 * - Truncates output to prevent context overflow.
 *
 * @param spec - The command specification.
 * @param args - Dynamic arguments for the command.
 * @param workspaceRoot - The root directory for execution and path validation.
 * @returns Command output or error details.
 */
export async function runCliTool(
    spec: CliCommandSpec,
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const rootAbs = resolve(workspaceRoot ?? process.cwd());
    // Cache the real root path for symlink validation
    let realRoot: string | undefined;

    const argv: string[] = [];
    for (const token of spec.args) {
        const required = token.match(/^\{(\w+)\}$/);
        const optional = token.match(/^\{(\w+)\?\}$/);
        if (required !== null || optional !== null) {
            const key = (required ?? optional)?.[1] ?? '';
            const value = args[key];
            if (value === undefined || value === null || value === '') {
                if (required !== null) {
                    return { ok: false, error: `Missing required parameter: ${key}` };
                }
                continue;
            }

            if (key === 'path') {
                const target = resolve(rootAbs, String(value));
                const inside = target === rootAbs || target.startsWith(rootAbs + sep);
                if (!inside) {
                    return { ok: false, error: `Path escapes the workspace: ${String(value)}` };
                }

                // Check symlink target only if the path exists
                try {
                    await access(target);
                    const realTarget = await realpath(target);
                    if (!realRoot) realRoot = await realpath(rootAbs);

                    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
                        return {
                            ok: false,
                            error: `Path target (symlink) escapes the workspace: ${String(value)}`,
                        };
                    }
                } catch {
                    // Path does not exist; standard resolve check is sufficient for creation scenarios.
                }
            }

            // Expand array values into multiple argv items (e.g., for git status --short)
            if (Array.isArray(value)) {
                for (const item of value) {
                    const part = String(item ?? '');
                    if (part.length > 0) argv.push(part);
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
        const { stdout, stderr } = await execFileAsync(spec.bin, argv, {
            cwd: rootAbs,
            timeout: spec.timeoutMs ?? 60_000,
            maxBuffer: 8 * 1_048_576, // 8MB buffer
            encoding: 'utf8',
        });

        // Combine stdout and stderr, but prioritize content for the agent
        const text = String(stdout ?? '').trim();
        // Note: We usually only return stdout for structured tools, but stderr is logged here if needed.

        if (text.length > maxChars) {
            return { ok: true, content: `${text.slice(0, maxChars)}\n…（output truncated）` };
        }
        return { ok: true, content: text };
    } catch (error) {
        const err = error as { code?: string; stderr?: string; message?: string };

        if (err.code === 'ENOENT') {
            // Auto-install missing tools and retry once
            const installed = await installCliTool(spec);
            if (!installed.ok) {
                return {
                    ok: false,
                    error: `${spec.bin} is missing and auto-install failed: ${installed.error}`,
                };
            }

            try {
                const { stdout } = await execFileAsync(spec.bin, argv, {
                    cwd: rootAbs,
                    timeout: spec.timeoutMs ?? 30_000,
                    maxBuffer: 1_048_576, // 1MB buffer for retry
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
                        error: `${spec.bin} still missing after install attempt`,
                    };
                }
                const stderr = String(retryErr.stderr ?? '').trim();
                return { ok: false, error: stderr.slice(0, 2000) || String(retryErr.message) };
            }
        }

        const stderr = String(err.stderr ?? '').trim();
        return { ok: false, error: stderr.slice(0, 2000) || String(err.message) };
    }
}

/**
 * Executes arbitrary shell commands (bash -lc) within the workspace.
 *
 * WARNING: This runs in a shell environment. While `cwd` is set,
 * filesystem access is not strictly sandboxed beyond the CWD.
 * Ensure the runtime environment (e.g., container) restricts access if strict isolation is required.
 *
 * @param args - Arguments containing the 'command' string.
 * @param workspaceRoot - The execution directory.
 * @returns Command output or error details.
 */
export async function runShellTool(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) {
        return { ok: false, error: 'Missing command parameter' };
    }

    const requested = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
        ? Math.min(600_000, Math.max(1_000, requested))
        : 120_000;

    const cwd = resolve(workspaceRoot ?? process.cwd());
    const MAX_OUTPUT = 60_000;

    try {
        const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 16 * 1_048_576,
            encoding: 'utf8',
        });

        const stderrText = String(stderr ?? '').trim();
        // Merge stdout and stderr to give full context, as shell tools often use stderr for info
        const merged = (
            String(stdout ?? '') + (stderrText ? `\n[stderr]\n${stderrText}` : '')
        ).trim();

        const content = merged.length > 0 ? merged : '(no output)';

        return {
            ok: true,
            content:
                content.length > MAX_OUTPUT
                    ? `${content.slice(0, MAX_OUTPUT)}\n…（output truncated）`
                    : content,
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

        const details: string[] = [];
        if (err.killed) details.push(`Command timed out after ${timeoutMs}ms`);
        if (typeof err.code === 'number') details.push(`exit code ${err.code}`);
        if (err.signal) details.push(`Signal: ${err.signal}`);

        const stdOutput = [String(err.stdout ?? '').trim(), String(err.stderr ?? '').trim()]
            .filter(Boolean)
            .join('\n');

        const message = [...details, stdOutput].filter(Boolean).join('\n').slice(0, 2000);

        return { ok: false, error: message || String(err.message) };
    }
}
