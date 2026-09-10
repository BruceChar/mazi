import { describe, expect, it } from 'vitest';
import { runShellTool } from '../src/runtime.js';

describe('shell.run（通用脚本/命令执行）', () => {
    it('执行命令并返回 stdout', async () => {
        const res = await runShellTool({ command: 'echo hello-shell' }, process.cwd());
        expect(res.ok).toBe(true);
        expect(res.content).toContain('hello-shell');
    });

    it('非零退出 → ok:false 且带 exit code', async () => {
        const res = await runShellTool({ command: 'exit 3' }, process.cwd());
        expect(res.ok).toBe(false);
        expect(res.error).toContain('exit code 3');
    });

    it('空 command → 报错', async () => {
        const res = await runShellTool({}, process.cwd());
        expect(res.ok).toBe(false);
        expect(res.error).toContain('command');
    });
});
