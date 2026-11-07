import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { effectPathsForTool } from '../src/effects/effect-store.js';
import { fsReadToolImpl } from '../src/harness/tool-executor.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
