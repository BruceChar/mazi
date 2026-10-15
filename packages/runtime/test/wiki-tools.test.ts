import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Step } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';

import { WikiService } from '../src/wiki/index.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function invocationStep(toolName: string, args: Record<string, unknown>): Step {
    return {
        stepId: 'step-1',
        taskId: 'task-1',
        goalId: 'goal-1',
        kind: 'invocation',
        payload: { toolName, arguments: args, output: 'ok' },
        status: 'succeeded',
        startedAt: 0,
    } as unknown as Step;
}

describe('WikiService', () => {
    it('工作区为空 → 静默禁用', () => {
        const service = new WikiService({ home: tempDir('mazi-home-'), workspace: '  ' });
        expect(service.enabled).toBe(false);
        expect(service.promptFragment()).toBe('');
    });

    it('无 wiki 注入提示；更新快照后注入快照', async () => {
        const service = new WikiService({
            home: tempDir('mazi-home-'),
            workspace: tempDir('mazi-ws-'),
        });
        expect(service.promptFragment()).toContain('本项目尚无 wiki');
        const updated = await service.updateForTool({
            snapshot: '## 项目概览\n一句话定位',
            entries: '新增项目 wiki 的读取与注入',
        });
        expect(updated.ok).toBe(true);
        expect(service.promptFragment()).toContain('### 项目概览');
    });

    it('observeStep 记 pending，flushRun 落功能级条目', async () => {
        const home = tempDir('mazi-home-');
        const service = new WikiService({ home, workspace: tempDir('mazi-ws-') });
        await service.beginRun();
        service.observeStep(invocationStep('fs.write', { path: 'src/a.ts' }));
        service.observeStep(invocationStep('rg', { args: ['foo'] }));
        const entries = await service.flushRun({ sessionId: 's1' });
        expect(entries).toHaveLength(1);
        expect(entries[0].change).toContain('src');
        expect(service.readForTool({ section: 'log' }).content).toContain(entries[0].change);
        expect(service.readForTool({ section: 'all' }).content).toContain('# ');
    });

    it('wiki.update 校验快照格式，非法输入返回错误', async () => {
        const service = new WikiService({
            home: tempDir('mazi-home-'),
            workspace: tempDir('mazi-ws-'),
        });
        const invalid = await service.updateForTool({ snapshot: '纯文本没有二级标题' });
        expect(invalid.ok).toBe(false);
        const empty = await service.updateForTool({});
        expect(empty.ok).toBe(false);
        expect(empty.error).toContain('未提供');
    });
});