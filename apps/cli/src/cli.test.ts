import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCli } from './args.js';
import { loadConfig } from './config.js';

describe('parseCli（MVP v1.0 §8 F15）', () => {
    it('解析 run 子命令与选项', () => {
        const opts = parseCli([
            'run',
            '读取文件并汇报',
            '--user',
            'u1',
            '--config-dir',
            '/tmp/cfg',
            '--interactive',
        ]);
        expect(opts.command).toBe('run');
        expect(opts.input).toBe('读取文件并汇报');
        expect(opts.userId).toBe('u1');
        expect(opts.configDir).toBe('/tmp/cfg');
        expect(opts.interactive).toBe(true);
    });
    it('缺省 configDir=MAZI_HOME（~/.mazi）', () => {
        const home = mkdtempSync(join(tmpdir(), 'mazi-home-'));
        process.env.MAZI_HOME = home;
        try {
            const opts = parseCli(['run', '任务']);
            expect(opts.configDir).toBe(home);
            expect(opts.userId).toBeUndefined();
        } finally {
            delete process.env.MAZI_HOME;
        }
    });
    it('缺少输入抛错', () => {
        expect(() => parseCli(['run'])).toThrow();
    });
});

describe('loadConfig', () => {
    it('读取 providers.json/tools.json/flags.json', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-cfg-'));
        writeFileSync(join(dir, 'providers.json'), JSON.stringify({ providers: [{ id: 'p1' }] }));
        writeFileSync(join(dir, 'tools.json'), JSON.stringify({ tools: [{ name: 'fs.read' }] }));
        writeFileSync(
            join(dir, 'flags.json'),
            JSON.stringify({ flags: [{ key: 'a', type: 'boolean', defaultValue: true }] }),
        );
        const cfg = loadConfig(dir);
        expect(cfg.providers).toHaveLength(1);
        expect(cfg.tools).toHaveLength(1);
        expect(cfg.flags).toHaveLength(1);
        rmSync(dir, { recursive: true, force: true });
    });
    it('缺失文件返回空配置', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-cfg2-'));
        const cfg = loadConfig(dir);
        expect(cfg.providers).toEqual([]);
        expect(cfg.tools).toEqual([]);
        rmSync(dir, { recursive: true, force: true });
    });
});
