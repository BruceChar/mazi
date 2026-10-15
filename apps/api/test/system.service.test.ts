import { describe, expect, it } from 'vitest';
import { SystemService } from '../src/system/system.service.js';

const ROOT = '/repo';
const PACKAGE_JSON = JSON.stringify({ name: 'mazi', version: '1.2.3' });

/** 伪 git：按子命令返回固定输出，并记录完整 argv（含 -C root）。 */
function fakeExec(overrides: Record<string, string> = {}) {
    const calls: string[][] = [];
    const exec = (command: string, args: readonly string[]): string => {
        calls.push([command, ...args]);
        const tail = args.slice(2).join(' ');
        return overrides[tail] ?? '';
    };
    return { calls, exec };
}

const HAPPY: Record<string, string> = {
    'describe --tags --always --dirty': 'v1.0.0-3-gabc1234',
    'rev-parse --short HEAD': 'abc1234',
    'rev-parse --abbrev-ref HEAD': 'main',
    'status --porcelain': ' M packages/libs/src/iteration.ts',
    'log -1 --format=%s': 'feat: iterations panel',
    'log -1 --format=%cI': '2026-01-02T03:04:05+08:00',
};

describe('SystemService', () => {
    it('info 读取 git describe/提交/分支/dirty/说明/时间与 package.json', () => {
        const { calls, exec } = fakeExec(HAPPY);
        const service = new SystemService({ exec, readFile: () => PACKAGE_JSON, root: ROOT });
        const info = service.info();

        expect(info.version).toBe('v1.0.0-3-gabc1234');
        expect(info.commit).toBe('abc1234');
        expect(info.branch).toBe('main');
        expect(info.dirty).toBe(true);
        expect(info.commitSubject).toBe('feat: iterations panel');
        expect(info.commitDate).toBe('2026-01-02T03:04:05+08:00');
        expect(info.packageVersion).toBe('1.2.3');
        expect(info.node).toBe(process.version);
        expect(info.platform).toBe(`${process.platform} ${process.arch}`);
        expect(typeof info.readAt).toBe('number');

        expect(calls).toContainEqual(['git', '-C', ROOT, 'describe', '--tags', '--always', '--dirty']);
        expect(calls).toContainEqual(['git', '-C', ROOT, 'status', '--porcelain']);
        expect(calls).toContainEqual(['git', '-C', ROOT, 'log', '-1', '--format=%s']);
    });

    it('readVersion 只返回轻量版本快照（供迭代记录注入 base/applied）', () => {
        const { exec } = fakeExec(HAPPY);
        const service = new SystemService({ exec, readFile: () => PACKAGE_JSON, root: ROOT });
        expect(service.readVersion()).toEqual({
            version: 'v1.0.0-3-gabc1234',
            commit: 'abc1234',
            branch: 'main',
            dirty: true,
        });
    });

    it('无 git（命令失败）降级为空字段 + packageVersion 回落，dirty=false，不抛错', () => {
        const exec = (): string => {
            throw new Error('git not found');
        };
        const service = new SystemService({ exec, readFile: () => PACKAGE_JSON, root: ROOT });
        const info = service.info();

        expect(info.version).toBe('1.2.3');
        expect(info.commit).toBe('');
        expect(info.branch).toBe('');
        expect(info.dirty).toBe(false);
        expect(info.commitSubject).toBe('');
        expect(info.commitDate).toBe('');
        expect(info.packageVersion).toBe('1.2.3');
    });

    it('describe 无输出时 version 回落 packageVersion', () => {
        const { exec } = fakeExec({ ...HAPPY, 'describe --tags --always --dirty': '' });
        const service = new SystemService({ exec, readFile: () => PACKAGE_JSON, root: ROOT });
        expect(service.readVersion().version).toBe('1.2.3');
    });

    it('package.json 读取失败 → packageVersion 与 version 均为空串，不抛错', () => {
        const { exec } = fakeExec();
        const readFile = (): string => {
            throw new Error('ENOENT');
        };
        const service = new SystemService({ exec, readFile, root: ROOT });
        expect(() => service.info()).not.toThrow();
        expect(service.readVersion()).toEqual({
            version: '',
            commit: '',
            branch: '',
            dirty: false,
        });
    });

    it('format 解析失败（不返回版本字段）→ 空 packageVersion', () => {
        const { exec } = fakeExec(HAPPY);
        const service = new SystemService({
            exec,
            readFile: () => JSON.stringify({ name: 'mazi' }),
            root: ROOT,
        });
        expect(service.info().packageVersion).toBe('');
        // 无 packageVersion 时 version 只可能是 git describe。
        expect(service.readVersion().version).toBe('v1.0.0-3-gabc1234');
    });
});
