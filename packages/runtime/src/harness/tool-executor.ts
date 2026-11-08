import { execFile } from 'node:child_process';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CliCommandSpec } from '../config.js';
import { detectPackageManager } from './system-probe.js';

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
    additionalRoots: readonly string[] = [],
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
        const allowedRoots = await Promise.all(
            [rootAbs, ...additionalRoots].map((root) => realpath(resolve(root))),
        );
        const allowed = allowedRoots.some(
            (root) => realPath === root || realPath.startsWith(root + sep),
        );
        if (!allowed) {
            return {
                ok: false,
                error: 'Path is outside the workspace and mounted skill directories',
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

/** Extended CLI spec: optional mutation expectation (kept local to avoid touching the config schema). */
type MutationAwareCommandSpec = CliCommandSpec & { expectMutation?: boolean };

/**
 * Commands whose success must be proven by a file change.
 * Some CLIs (notably `sd`) exit 0 even when their pattern does not match, silently doing nothing.
 */
const MUTATING_FILE_BINS = new Set(['sd']);

function expectsFileMutation(spec: MutationAwareCommandSpec): boolean {
    // Match on the binary name so an absolute path (e.g. /opt/homebrew/bin/sd) is recognised too.
    return spec.expectMutation === true || MUTATING_FILE_BINS.has(basename(spec.bin));
}

interface FileSnapshot {
    exists: boolean;
    content?: string;
}

/** Best-effort mutation target: the resolved `path` argument (e.g. the file `sd` writes). */
function resolveMutationTarget(
    args: Record<string, unknown>,
    rootAbs: string,
): { absolutePath: string } | undefined {
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!path) return undefined;
    const absolutePath = resolve(rootAbs, path);
    const inside = absolutePath === rootAbs || absolutePath.startsWith(rootAbs + sep);
    return inside ? { absolutePath } : undefined;
}

/** Snapshot a file before a mutating command; undefined means "cannot verify" (skip detection). */
async function snapshotFile(absolutePath: string): Promise<FileSnapshot | undefined> {
    try {
        const stats = await stat(absolutePath);
        if (!stats.isFile() || stats.size > 10 * 1024 * 1024) return undefined;
        return { exists: true, content: await readFile(absolutePath, 'utf8') };
    } catch (error) {
        return (error as { code?: string }).code === 'ENOENT' ? { exists: false } : undefined;
    }
}

/**
 * Detects mutating commands that report success without changing their target file.
 * Returns an error message for a swallowed failure, or undefined when the file changed (or cannot
 * be verified, in which case the command result is trusted).
 */
async function detectMissingMutation(
    spec: MutationAwareCommandSpec,
    target: { absolutePath: string } | undefined,
    before: FileSnapshot | undefined,
): Promise<string | undefined> {
    if (target === undefined || before === undefined) return undefined;
    const after = await snapshotFile(target.absolutePath);
    if (after === undefined) return undefined;
    const label = basename(spec.bin);
    if (!after.exists) return `no change: target file does not exist (${label})`;
    if (before.exists && before.content === after.content) {
        return `no change: pattern did not match (${label})`;
    }
    return undefined;
}

/** Argument key (in `spec.args`) that an optional `spec.globFlag` is inserted before. */
const GLOB_FLAG_ARG_KEY = 'pattern';

/**
 * Returns the flag that switches `spec` to glob mode for a pattern argument, or undefined to keep
 * regex semantics. Glob mode is used only when the pattern contains glob metacharacters AND cannot
 * be compiled as a regex (e.g. fd's `*.md`); valid regex patterns such as `.*\.md$` are untouched.
 */
function globFlagFor(spec: CliCommandSpec, key: string, pattern: string): string | undefined {
    if (spec.globFlag === undefined || key !== GLOB_FLAG_ARG_KEY) return undefined;
    const hasGlobMeta = pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
    if (!hasGlobMeta) return undefined;
    try {
        new RegExp(pattern);
        return undefined; // Valid regex: keep the tool's default regex semantics.
    } catch {
        return spec.globFlag;
    }
}

/** True when a non-zero exit code is declared as a successful "no result" signal (e.g. rg exit 1). */
function isNoMatchExit(spec: CliCommandSpec, code: unknown): boolean {
    return typeof code === 'number' && spec.noMatchExitCodes?.includes(code) === true;
}

function noMatchResult(spec: CliCommandSpec): { ok: boolean; content: string } {
    return { ok: true, content: spec.noMatchContent ?? '(no matches)' };
}

/**
 * Executes a CLI tool with arguments defined in a spec.
 *
 * Security & Robustness features:
 * - Prevents path traversal via argument validation.
 * - Checks for symlink escapes on existing paths.
 * - Handles missing tools via auto-installation.
 * - Truncates output to prevent context overflow.
 * - Maps declared "no result" exit codes to success (e.g. rg exit 1 = no matches).
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
            let value = args[key];
            if (value === undefined || value === null || value === '') {
                if (required !== null) {
                    return { ok: false, error: `Missing required parameter: ${key}` };
                }
                const fallback = spec.argDefaults?.[key];
                if (fallback === undefined) continue;
                value = fallback;
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

            // Glob-mode switch for pattern arguments (e.g. fd `*.md` → `--glob *.md`).
            const globFlag = typeof value === 'string' ? globFlagFor(spec, key, value) : undefined;
            if (globFlag !== undefined) argv.push(globFlag);

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
    // Mutating tools (e.g. sd) may exit 0 without changing the target: snapshot it to verify later.
    const mutationTarget = expectsFileMutation(spec)
        ? resolveMutationTarget(args, rootAbs)
        : undefined;
    const mutationBefore = mutationTarget
        ? await snapshotFile(mutationTarget.absolutePath)
        : undefined;

    try {
        const { stdout } = await execFileAsync(spec.bin, argv, {
            cwd: rootAbs,
            timeout: spec.timeoutMs ?? 60_000,
            maxBuffer: 8 * 1_048_576, // 8MB buffer
            encoding: 'utf8',
        });

        const mutationError = await detectMissingMutation(spec, mutationTarget, mutationBefore);
        if (mutationError) return { ok: false, error: mutationError };

        // Combine stdout and stderr, but prioritize content for the agent
        const text = String(stdout ?? '').trim();
        // Note: We usually only return stdout for structured tools, but stderr is logged here if needed.

        if (text.length > maxChars) {
            return { ok: true, content: `${text.slice(0, maxChars)}\n…（output truncated）` };
        }
        return { ok: true, content: text };
    } catch (error) {
        const err = error as {
            code?: string | number;
            stderr?: string;
            message?: string;
        };

        // A declared non-zero "no result" exit (e.g. rg exit 1 = no matches) is a successful
        // empty result, not a tool failure. Real errors (rg exit 2, fd parse error) stay ok:false.
        if (isNoMatchExit(spec, err.code)) return noMatchResult(spec);

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
                const mutationError = await detectMissingMutation(
                    spec,
                    mutationTarget,
                    mutationBefore,
                );
                if (mutationError) return { ok: false, error: mutationError };
                const text = String(stdout ?? '').trim();
                return {
                    ok: true,
                    content:
                        text.length > maxChars
                            ? `${text.slice(0, maxChars)}\n…（output truncated）`
                            : text,
                };
            } catch (retryError) {
                const retryErr = retryError as {
                    code?: string | number;
                    stderr?: string;
                    message?: string;
                };
                if (retryErr.code === 'ENOENT') {
                    return {
                        ok: false,
                        error: `${spec.bin} still missing after install attempt`,
                    };
                }
                if (isNoMatchExit(spec, retryErr.code)) return noMatchResult(spec);
                const stderr = String(retryErr.stderr ?? '').trim();
                return { ok: false, error: stderr.slice(0, 2000) || String(retryErr.message) };
            }
        }

        const stderr = String(err.stderr ?? '').trim();
        return { ok: false, error: stderr.slice(0, 2000) || String(err.message) };
    }
}

/**
 * Executes arbitrary shell commands (bash -o pipefail -lc) within the workspace.
 * pipefail is required so a failing command inside a pipeline (e.g. `cargo test | tail`)
 * still surfaces its exit code instead of being masked by the last pipeline element.
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
        const { stdout, stderr } = await execFileAsync('bash', ['-o', 'pipefail', '-lc', command], {
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

        // SIGPIPE (exit 141) usually means a downstream consumer closed early
        // (e.g. `git log | head -3`). The command itself ran; do not report a failure.
        if (!err.killed && (err.code === 141 || err.signal === 'SIGPIPE')) {
            const piped = [String(err.stdout ?? '').trim(), String(err.stderr ?? '').trim()]
                .filter(Boolean)
                .join('\n');
            return {
                ok: true,
                content: [piped, '[exit 141: SIGPIPE ignored; downstream consumer closed early]']
                    .filter((part) => part.length > 0)
                    .join('\n'),
            };
        }

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
