import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliCommandSpec } from '../src/config.js';
import { effectPathsForTool } from '../src/effects/effect-store.js';
import { fsReadToolImpl, runCliTool, runShellTool } from '../src/harness/tool-executor.js';
import { BUILTIN_TOOL_PRESET } from '../src/tool-gateway/builtin.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Locate a CLI binary: prefer absolute homebrew paths, then PATH lookup (keeps tests stable). */
function resolveBinary(name: string): string | undefined {
    for (const candidate of [
        `/opt/homebrew/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/opt/local/bin/${name}`,
    ]) {
        if (existsSync(candidate)) return candidate;
    }
    try {
        const found = execFileSync('bash', ['-lc', `command -v ${name}`], {
            encoding: 'utf8',
        }).trim();
        return found.length > 0 ? found : undefined;
    } catch {
        return undefined;
    }
}

const SD_BIN = resolveBinary('sd');
const RG_BIN = resolveBinary('rg');
const FD_BIN = resolveBinary('fd');

/** Use the real builtin command spec (so config wiring is covered) with a resolved binary. */
function builtinCommand(name: string, bin: string | undefined): CliCommandSpec {
    const tool = BUILTIN_TOOL_PRESET.find((entry) => entry.name === name);
    if (!tool?.command) throw new Error(`builtin tool ${name} has no command spec`);
    return { ...tool.command, bin: bin ?? tool.command.bin };
}

function sdSpec(): CliCommandSpec {
    return {
        bin: SD_BIN ?? 'sd',
        args: ['{pattern}', '{replacement}', '{path}'],
        timeoutMs: 15_000,
    };
}

function rgSpec(): CliCommandSpec {
    return builtinCommand('rg', RG_BIN);
}

function fdSpec(): CliCommandSpec {
    return builtinCommand('fd', FD_BIN);
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

describe.skipIf(!RG_BIN)('rg 无匹配退出码（noMatchExitCodes）', () => {
    it('无匹配（exit 1）→ ok:true + "(no matches)"，不误报失败', async () => {
        const workspace = tempDir('mazi-rg-nomatch-');
        writeFileSync(join(workspace, 'a.txt'), 'hello world\n', 'utf8');

        const res = await runCliTool(rgSpec(), { pattern: 'absent_token_xyz' }, workspace);

        expect(res.ok).toBe(true);
        expect(res.content).toBe('(no matches)');
    });

    it('真实错误（搜索路径不存在，exit 2）→ 仍然 ok:false', async () => {
        const workspace = tempDir('mazi-rg-error-');

        const res = await runCliTool(rgSpec(), { pattern: 'x', path: 'missing-dir' }, workspace);

        expect(res.ok).toBe(false);
        expect(res.error).toBeTruthy();
        expect(res.error).toMatch(/no such file|io error/i);
    });

    it('命中 → ok:true 且返回匹配内容', async () => {
        const workspace = tempDir('mazi-rg-hit-');
        writeFileSync(join(workspace, 'a.txt'), 'hello needle\n', 'utf8');

        const res = await runCliTool(rgSpec(), { pattern: 'needle' }, workspace);

        expect(res.ok).toBe(true);
        expect(res.content).toContain('needle');
    });
});

// 输出契约：纯文本（path:line:text），不用 --json。
// --json 的 JSONL 体积约为纯文本 10 倍，既易撞 8MB maxBuffer，40k 截断还会把一行 JSON 劈成非法片段。
describe.skipIf(!RG_BIN)('rg 输出契约（纯文本，非 --json）', () => {
    it('输出形如 path:line:text，不含 JSON 事件', async () => {
        const workspace = tempDir('mazi-rg-text-');
        writeFileSync(join(workspace, 'a.txt'), 'hello needle\n', 'utf8');

        const res = await runCliTool(rgSpec(), { pattern: 'needle' }, workspace);

        expect(res.ok).toBe(true);
        expect(res.content).toContain(':1:hello needle');
        expect(res.content).not.toContain('{"type"');
    });

    it('maxOutputChars 生效并带截断标记', async () => {
        const workspace = tempDir('mazi-rg-truncate-');
        writeFileSync(join(workspace, 'a.txt'), 'needle\n'.repeat(200), 'utf8');

        const res = await runCliTool(
            { ...rgSpec(), maxOutputChars: 60 },
            { pattern: 'needle' },
            workspace,
        );

        expect(res.ok).toBe(true);
        expect(res.content?.endsWith('…（output truncated）')).toBe(true);
    });
});

describe.skipIf(!FD_BIN)('fd glob/regex 模式（globFlag）', () => {
    it('glob `*.md`（fd 默认按 regex 会 parse error）→ ok:true 且只返回匹配文件', async () => {
        const workspace = tempDir('mazi-fd-glob-');
        writeFileSync(join(workspace, 'alpha.md'), '# alpha\n', 'utf8');
        writeFileSync(join(workspace, 'beta.txt'), 'beta\n', 'utf8');

        const res = await runCliTool(fdSpec(), { pattern: '*.md' }, workspace);

        expect(res.ok).toBe(true);
        expect(res.content).toContain('alpha.md');
        expect(res.content).not.toContain('beta.txt');
    });

    it('glob 无匹配（fd exit 0）→ ok:true 空结果', async () => {
        const workspace = tempDir('mazi-fd-glob-empty-');
        writeFileSync(join(workspace, 'alpha.md'), '# alpha\n', 'utf8');

        const res = await runCliTool(fdSpec(), { pattern: '*.rs' }, workspace);

        expect(res.ok).toBe(true);
        expect(res.content ?? '').not.toContain('alpha.md');
    });

    it('合法 regex（含 * 元字符，如 `.*\\.md$`）仍按 regex 语义执行 → ok:true', async () => {
        const workspace = tempDir('mazi-fd-regex-');
        writeFileSync(join(workspace, 'alpha.md'), '# alpha\n', 'utf8');
        writeFileSync(join(workspace, 'beta.txt'), 'beta\n', 'utf8');

        const res = await runCliTool(fdSpec(), { pattern: '.*\\.md$' }, workspace);

        expect(res.ok).toBe(true);
        expect(res.content).toContain('alpha.md');
        expect(res.content).not.toContain('beta.txt');
    });

    it('既非 glob 也非法 regex（如 `a(b`）→ ok:false（真实错误不吞）', async () => {
        const workspace = tempDir('mazi-fd-bad-regex-');

        const res = await runCliTool(fdSpec(), { pattern: 'a(b' }, workspace);

        expect(res.ok).toBe(false);
        expect(res.error).toContain('regex parse error');
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

