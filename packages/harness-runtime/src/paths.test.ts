import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    configOverview,
    defaultConfigDir,
    defaultDbPath,
    defaultEventDir,
    ensureMaziDirs,
    loadRuntimeConfig,
    maziHome,
    maziPaths,
    toRuntimeConfig,
} from './index.js';

const homes: string[] = [];

function tmpHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-home-'));
    homes.push(dir);
    return dir;
}

afterEach(() => {
    for (const h of homes.splice(0)) {
        rmSync(h, { recursive: true, force: true });
    }
    delete process.env.MAZI_HOME;
});

describe('~/.mazi 用户目录路径（设计文档 §1 / U1 U2）', () => {
    it('maziPaths：json 平铺根、db 与 events 在 home 下', () => {
        const home = tmpHome();
        const p = maziPaths(home);
        expect(p.providersFile).toBe(join(home, 'providers.json'));
        expect(p.toolsFile).toBe(join(home, 'tools.json'));
        expect(p.flagsFile).toBe(join(home, 'flags.json'));
        expect(p.dbPath).toBe(join(home, 'mazi.db'));
        expect(p.eventDir).toBe(join(home, 'events'));
    });

    it('MAZI_HOME 覆盖默认目录', () => {
        const home = tmpHome();
        process.env.MAZI_HOME = home;
        expect(maziHome()).toBe(home);
        expect(defaultConfigDir()).toBe(home);
        expect(defaultDbPath()).toBe(join(home, 'mazi.db'));
        expect(defaultEventDir()).toBe(join(home, 'events'));
    });

    it('ensureMaziDirs 自动创建 home/events', () => {
        const home = tmpHome();
        const p = ensureMaziDirs(home);
        const { existsSync } = require('node:fs') as typeof import('node:fs');
        expect(existsSync(p.home)).toBe(true);
        expect(existsSync(p.eventDir)).toBe(true);
    });
});

describe('配置加载与 RuntimeConfig 组装（U1）', () => {
    it('loadRuntimeConfig 读取 home 下三个 json；缺失为空数组', () => {
        const home = tmpHome();
        writeFileSync(join(home, 'providers.json'), JSON.stringify({ providers: [{ id: 'x' }] }));
        writeFileSync(join(home, 'tools.json'), JSON.stringify({ tools: [{ name: 'fs.read' }] }));
        const file = loadRuntimeConfig(home);
        expect(file.providers.map((p) => p.id)).toEqual(['x']);
        expect(file.tools.map((t) => t.name)).toEqual(['fs.read']);
        expect(file.flags).toEqual([]);
    });

    it('toRuntimeConfig：缺省存储落到 home（db=home/mazi.db, events=home/events）', () => {
        const home = tmpHome();
        process.env.MAZI_HOME = home;
        const cfg = toRuntimeConfig({ providers: [], tools: [], flags: [] });
        expect(cfg.eventDir).toBe(join(home, 'events'));
        expect(cfg.dbPath).toBe(join(home, 'mazi.db'));
        const cfg2 = toRuntimeConfig(
            { providers: [], tools: [], flags: [] },
            { consoleEnabled: true },
        );
        expect(cfg2.dbPath).toBe(join(home, 'mazi.db'));
    });

    it('configOverview 汇总默认 home 与 provider id', () => {
        const home = tmpHome();
        writeFileSync(
            join(home, 'providers.json'),
            JSON.stringify({ providers: [{ id: 'deepseek' }] }),
        );
        process.env.MAZI_HOME = home;
        const overview = configOverview();
        expect(overview.home).toBe(home);
        expect(overview.providers).toEqual(['deepseek']);
        expect(overview.hasProvidersFile).toBe(true);
    });
});
