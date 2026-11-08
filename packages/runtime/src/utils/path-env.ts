import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 可执行文件 PATH 兜底。
 *
 * 内置 CLI 工具（rg/fd/xh…）由 `execFile` 直接按名字解析，继承 **API 进程**的 PATH；
 * 而 `shell.run` 继承登录 shell 的 PATH。两者不一定一致，从 Finder/launchd 启动时
 * 常见「grep 能用、rg 不能用」——系统命令在 /usr/bin，Homebrew 工具在 /opt/homebrew/bin。
 * 这里在启动期把缺失但存在的常见目录追加到 PATH 末尾，把这类环境差异收敛掉。
 */

/** 目录归一：去掉尾斜杠，根目录保留。重复判定用它。 */
function normalizeDir(dir: string): string {
    const stripped = dir.replace(/\/+$/, '');
    return stripped.length > 0 ? stripped : '/';
}

function splitPath(value: string | undefined): string[] {
    return (value ?? '').split(':').filter((entry) => entry.length > 0);
}

/**
 * 平台常见但可能不在 PATH 里的可执行目录（按优先级排列）。
 * Windows 不做兜底：PATH 分隔符与安装布局都不同，且本项目运行面为 macOS/Linux。
 */
export function executablePathCandidates(
    platform: NodeJS.Platform = process.platform,
    home: string = homedir(),
): string[] {
    const userLocal = [join(home, '.local', 'bin'), join(home, '.cargo', 'bin')];
    if (platform === 'win32') return [];
    if (platform === 'darwin') {
        return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', ...userLocal];
    }
    return ['/usr/local/bin', ...userLocal];
}

/**
 * 计算补齐后的 PATH：只在**末尾追加**缺失且存在的目录。
 * 追加而非前置，避免遮蔽系统同名命令；已存在的条目与其顺序保持原样。
 */
export function augmentedExecutablePath(
    pathValue: string | undefined,
    candidates: readonly string[],
    isDirectory: (candidate: string) => boolean,
): string {
    const entries = splitPath(pathValue);
    const seen = new Set(entries.map(normalizeDir));
    const appended: string[] = [];
    for (const candidate of candidates) {
        const key = normalizeDir(candidate);
        if (seen.has(key) || !isDirectory(candidate)) continue;
        seen.add(key);
        appended.push(candidate);
    }
    return [...entries, ...appended].join(':');
}

/**
 * 进程级 PATH 兜底：原地改写 `env.PATH`，返回本次新增的目录（幂等，第二次返回空数组）。
 * 调用点：API bootstrap（在创建任何工具执行器之前）。
 */
export function ensureExecutablePath(
    env: { PATH?: string } = process.env,
    isDirectory: (candidate: string) => boolean = (candidate) => {
        try {
            return existsSync(candidate) && statSync(candidate).isDirectory();
        } catch {
            return false;
        }
    },
    candidates: readonly string[] = executablePathCandidates(),
): string[] {
    if (process.platform === 'win32') return [];
    const current = splitPath(env.PATH);
    const augmented = augmentedExecutablePath(env.PATH, candidates, isDirectory);
    if (augmented === (env.PATH ?? '')) return [];
    env.PATH = augmented;
    return splitPath(augmented).slice(current.length);
}
