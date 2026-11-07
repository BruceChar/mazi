import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliCommandSpec } from '../src/config.js';
import { effectPathsForTool } from '../src/effects/effect-store.js';
import { fsReadToolImpl, runCliTool, runShellTool } from '../src/harness/tool-executor.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Locate the sd binary: prefer absolute homebrew paths, then PATH lookup (keeps tests stable). */
function resolveSdBin(): string | undefined {
    for (const candidate of ['/opt/homebrew/bin/sd', '/usr/local/bin/sd', '/opt/local/bin/sd']) {
        if (existsSync(candidate)) return candidate;
    }
    try {
        const found = execFileSync('bash', ['-lc', 'command -v sd'], { encoding: 'utf8' }).trim();
        return found.length > 0 ? found : undefined;
    } catch {
        return undefined;
    }
}

const SD_BIN = resolveSdBin();

function sdSpec(): CliCommandSpec {
    return {
        bin: SD_BIN ?? 'sd',
        args: ['{pattern}', '{replacement}', '{path}'],
        timeoutMs: 15_000,
    };
}

describe('fs.read 路径边界', () => {
    it('可读工作区外的已挂载 Skill 文件，但不能读任意外部文件', async () => {
        const workspace = tempDir('mazi-read-workspace-');
        const skillDir = tempDir('mazi-read-skill-');
        const outside = tempDir('mazi-read-outside-');
        const skillFile = join(skillDir, 'SKILL.md');
        const outsideFile = join(outside, 'secret.txt');
        writeFileSync(skillFile, '# mounted skill\n', 'utf8');
        writeFileSync(outsideFile, 'not allowed\n', 'utf8');

        const skill = await fsReadToolImpl({ path: skillFile }, workspace, [skillDir]);
        expect(skill).toMatchObject({ ok: true, content: '# mounted skill\n' });

        const denied = await fsReadToolImpl({ path: outsideFile }, workspace, [skillDir]);
        expect(denied.ok).toBe(false);
        expect(denied.error).toContain('outside the workspace');
        expect(
            effectPathsForTool({ name: 'fs.read', sideEffects: ['fs'] }, { path: skillFile }),
        ).toEqual([]);
        expect(dirname(skillFile)).toBe(skillDir);
    });
});

describe('shell.run 失败信号（pipefail）', () => {
    it('成功管道 → ok:true', async () => {
        const workspace = tempDir('mazi-shell-pipe-ok-');
        const res = await runShellTool({ command: 'echo hi | tail -1' }, workspace);
        expect(res.ok).toBe(true);
        expect(res.content).toContain('hi');
    });

    it('管道中任一命令失败 → ok:false 且错误含 exit code', async () => {
        const workspace = tempDir('mazi-shell-pipe-fail-');
        const res = await runShellTool({ command: 'false | tail -1' }, workspace);
        expect(res.ok).toBe(false);
        expect(res.error).toContain('exit code');
    });

    it('普通非零退出 → ok:false', async () => {
        const workspace = tempDir('mazi-shell-exit-');
        const res = await runShellTool({ command: 'exit 3' }, workspace);
        expect(res.ok).toBe(false);
        expect(res.error).toContain('exit code 3');
    });
});

describe.skipIf(!SD_BIN)('sd 无改动检测（expectMutation）', () => {
    it('pattern 未匹配（sd 退出 0）→ ok:false 且提示 no change', async () => {
        const workspace = tempDir('mazi-sd-nomatch-');
        writeFileSync(join(workspace, 'a.txt'), 'hello world\n', 'utf8');

        const res = await runCliTool(
            sdSpec(),
            { pattern: 'absent', replacement: 'x', path: 'a.txt' },
            workspace,
        );

        expect(res.ok).toBe(false);
        expect(res.error).toContain('no change');
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello world\n');
    });

    it('多行 pattern 未匹配（真实故障场景）→ ok:false', async () => {
        const workspace = tempDir('mazi-sd-multiline-');
        writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');

        const res = await runCliTool(
            sdSpec(),
            { pattern: 'one\ntwo', replacement: 'X', path: 'a.txt' },
            workspace,
        );

        expect(res.ok).toBe(false);
        expect(res.error).toContain('no change');
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    });

    it('pattern 命中并修改文件 → ok:true', async () => {
        const workspace = tempDir('mazi-sd-hit-');
        writeFileSync(join(workspace, 'a.txt'), 'hello world\n', 'utf8');

        const res = await runCliTool(
            sdSpec(),
            { pattern: 'world', replacement: 'mazi', path: 'a.txt' },
            workspace,
        );

        expect(res.ok).toBe(true);
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello mazi\n');
    });

    it('目标文件不存在 → ok:false（既有路径校验语义）', async () => {
        const workspace = tempDir('mazi-sd-missing-');
        const res = await runCliTool(
            sdSpec(),
            { pattern: 'a', replacement: 'b', path: 'missing.txt' },
            workspace,
        );

        expect(res.ok).toBe(false);
        expect(res.error).toBeTruthy();
    });
});

describe('shell.run · SIGPIPE', () => {
    it('下游提前关闭（| head）不算命令失败', async () => {
        const workspace = tempDir('mazi-shell-sigpipe-');
        const res = await runShellTool({ command: 'yes mazi | head -1' }, workspace);
        expect(res.ok).toBe(true);
        expect(res.content).toContain('mazi');
        expect(res.content).toContain('SIGPIPE ignored');
    });
});

