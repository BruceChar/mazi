import { describe, expect, it } from 'vitest';
import {
    augmentedExecutablePath,
    executablePathCandidates,
    ensureExecutablePath,
} from '../src/utils/path-env.js';

/** 便于构造：给定「真实存在的目录集合」的探测器。 */
function existingDirs(...dirs: string[]): (candidate: string) => boolean {
    const set = new Set(dirs);
    return (candidate) => set.has(candidate.replace(/\/+$/, ''));
}

describe('executable PATH 兜底', () => {
    it('把缺失但存在的目录追加到末尾', () => {
        const result = augmentedExecutablePath(
            '/usr/bin:/bin',
            ['/opt/homebrew/bin', '/usr/local/bin'],
            existingDirs('/opt/homebrew/bin'),
        );

        expect(result).toBe('/usr/bin:/bin:/opt/homebrew/bin');
    });

    it('已在 PATH 里的目录不重复追加', () => {
        const result = augmentedExecutablePath(
            '/usr/bin:/opt/homebrew/bin',
            ['/opt/homebrew/bin'],
            existingDirs('/opt/homebrew/bin'),
        );

        expect(result).toBe('/usr/bin:/opt/homebrew/bin');
    });

    it('保持既有顺序（不前置、不遮蔽系统同名命令）', () => {
        const result = augmentedExecutablePath(
            '/usr/bin:/usr/local/bin:/bin',
            ['/usr/local/bin', '/opt/homebrew/bin'],
            existingDirs('/usr/local/bin', '/opt/homebrew/bin'),
        );

        expect(result).toBe('/usr/bin:/usr/local/bin:/bin:/opt/homebrew/bin');
    });

    it('不存在的候选目录不写入', () => {
        const result = augmentedExecutablePath(
            '/usr/bin',
            ['/opt/homebrew/bin'],
            existingDirs(),
        );

        expect(result).toBe('/usr/bin');
    });

    it('空 PATH 时只保留存在的候选', () => {
        const result = augmentedExecutablePath(
            undefined,
            ['/opt/homebrew/bin'],
            existingDirs('/opt/homebrew/bin'),
        );

        expect(result).toBe('/opt/homebrew/bin');
    });

    it('尾斜杠差异视为同一目录', () => {
        const result = augmentedExecutablePath(
            '/usr/bin:/opt/homebrew/bin/',
            ['/opt/homebrew/bin'],
            existingDirs('/opt/homebrew/bin'),
        );

        expect(result).toBe('/usr/bin:/opt/homebrew/bin/');
    });

    it('ensureExecutablePath 返回本次新增的条目，可重复调用且幂等', () => {
        const env = { PATH: '/usr/bin' };
        const candidates = executablePathCandidates('darwin', '/Users/example');
        // 用真实文件系统探测：此处只验证契约形状，避免依赖机器上装了哪些工具。
        const first = ensureExecutablePath(env, () => true, candidates);
        const second = ensureExecutablePath(env, () => true, candidates);

        expect(first.length).toBeGreaterThan(0);
        expect(second).toEqual([]);
        expect(env.PATH.startsWith('/usr/bin:')).toBe(true);
    });
});
