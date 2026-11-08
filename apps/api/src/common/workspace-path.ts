import { resolve } from 'node:path';

/**
 * 归一化工作区（项目）路径，用于持久化与比较：
 * - 去掉结尾斜杠（`/a/b/` → `/a/b`），解析 `.` / `..`（node:path resolve）；
 * - 纯字符串运算：不访问文件系统、不解析 symlink、macOS 大小写保持原样。
 *
 * 历史数据里同一目录可能同时以「带/不带尾斜杠」两种形式持久化（系统目录选择器
 * 返回带尾斜杠，手输 / 事件流返回不带），归一化后才能判定为同一项目并去重。
 */
export function normalizeWorkspacePath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0) return '';
    return resolve(trimmed);
}

/** 两个工作区路径是否指向同一目录（按 {@link normalizeWorkspacePath} 比较）。 */
export function sameWorkspacePath(a: string, b: string): boolean {
    return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

/**
 * 判断字符串是否以绝对路径形式出现。历史 conversations.json 的 projectId
 * 偶有把工作区路径直接当 projectId 落盘的情况；只有这种值才需要路径归一化，
 * 正常 projectId（projectIdForWorkspace 生成的 hash）保持原样。
 */
export function looksLikeWorkspacePath(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    return trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed);
}
