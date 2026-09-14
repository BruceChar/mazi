import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5_000;

/** 各平台候选包管理器（按优先级排序） */
const PLATFORM_CANDIDATES: Partial<Record<NodeJS.Platform, readonly string[]>> = {
    darwin: ['brew'],
    win32: ['winget', 'choco', 'scoop'],
    linux: ['apt-get', 'dnf', 'apk'],
};
/** 未枚举平台（freebsd / android 等）按 Unix 常见候选兜底 */
const FALLBACK_CANDIDATES: readonly string[] = ['apt-get', 'dnf', 'apk'];

/** 探测工具：Windows 用 where，其余平台用 which */
const probeUtil = process.platform === 'win32' ? 'where' : 'which';

type ProbeResult =
    | { status: 'found'; path: string }
    | { status: 'not-installed' }                     // 预期：该包管理器未安装
    | { status: 'timeout'; message: string }          // 探测超时
    | { status: 'probe-unavailable'; message: string } // which/where 本身缺失
    | { status: 'error'; message: string };            // 未知错误，保守跳过

interface ExecError extends NodeJS.ErrnoException {
    code?: string;
    killed?: boolean;
    signal?: string | null;
    cmd?: string;
}

async function probe(cmd: string): Promise<ProbeResult> {
    try {
        const { stdout } = await execFileAsync(probeUtil, [cmd], {
            timeout: PROBE_TIMEOUT_MS,
            windowsHide: true, // 避免 Windows 下闪现控制台窗口
        });
        const path = stdout.trim().split(/\r?\n/)[0]?.trim();
        return path
            ? { status: 'found', path }
            : { status: 'error', message: `"${probeUtil} ${cmd}" 退出码 0 但无输出` };
    } catch (err) {
        const e = err as ExecError;
        // 1) 探测工具自身缺失（spawn ENOENT）：继续探测无意义，中止整个流程
        if (e.code === 'ENOENT') {
            return { status: 'probe-unavailable', message: `探测工具 "${probeUtil}" 不可用：${e.message}` };
        }
        // 2) 超时被 kill：该候选不可用，尝试下一个
        if (e.killed || e.signal === 'SIGTERM') {
            return { status: 'timeout', message: `探测 "${cmd}" 超时（${PROBE_TIMEOUT_MS}ms）` };
        }
        // 3) 非零退出码：which/where 没找到目标 —— 预期的「未安装」，静默跳过
        if (typeof e.code === 'number') {
            return { status: 'not-installed' };
        }
        // 4) 其余（EACCES / EPERM 等）：保守视为未找到，但留下痕迹
        return { status: 'error', message: `探测 "${cmd}" 失败：${e.message}` };
    }
}

/**
 * 探测可用包管理器：
 * - macOS：brew
 * - Windows：winget / choco / scoop（优先级从高到低）
 * - Linux 及其它：apt-get / dnf / apk
 * @returns 包管理器命令名，探测不到返回 undefined
 */
export async function detectPackageManager(
    onWarn: (message: string) => void = console.warn,
): Promise<string | undefined> {
    const candidates = PLATFORM_CANDIDATES[process.platform] ?? FALLBACK_CANDIDATES;

    for (const candidate of candidates) {
        const result = await probe(candidate);

        if (result.status === 'found') {
            return candidate;
        }
        if (result.status === 'probe-unavailable') {
            onWarn(`[detectPackageManager] ${result.message}，跳过后续探测`);
            return undefined;
        }
        if (result.status === 'timeout' || result.status === 'error') {
            onWarn(`[detectPackageManager] ${result.message}，尝试下一个候选`);
        }
        // 'not-installed'：预期流程，静默继续
    }
    return undefined;
}
