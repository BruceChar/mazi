import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildConfigFiles,
    buildProviderConfig,
    envStatus,
    PROVIDER_PRESETS,
    resolvePresetSelections,
} from './configure.js';

describe('交互式配置纯函数（mazi config）', () => {
    it('resolvePresetSelections：数字/逗号/空格/id 均可解析且去重', () => {
        expect(resolvePresetSelections('1,2', PROVIDER_PRESETS)).toEqual(['openai', 'deepseek']);
        expect(resolvePresetSelections('3 1', PROVIDER_PRESETS)).toEqual([
            'scripted-demo',
            'openai',
        ]);
        expect(resolvePresetSelections('deepseek,openai', PROVIDER_PRESETS)).toEqual([
            'deepseek',
            'openai',
        ]);
        expect(resolvePresetSelections('99', PROVIDER_PRESETS)).toEqual([]);
        expect(resolvePresetSelections('2,2,3', PROVIDER_PRESETS)).toEqual([
            'deepseek',
            'scripted-demo',
        ]);
    });

    it('buildProviderConfig：openai 默认 key env，未显式 apiKeyEnv（靠 driver 默认映射读取 OPENAI_API_KEY）', () => {
        const cfg = buildProviderConfig({ presetId: 'openai', model: 'gpt-4o-mini' });
        expect(cfg.driver).toMatchObject({
            type: 'pi-ai',
            provider: 'openai',
            model: 'gpt-4o-mini',
        });
        expect((cfg.driver as { apiKeyEnv?: string }).apiKeyEnv).toBeUndefined();
    });

    it('buildProviderConfig：deepseek 默认模型与 key env；自定义 apiKeyEnv 会写入', () => {
        const cfg = buildProviderConfig({
            presetId: 'deepseek',
            model: 'deepseek-chat',
            keyEnv: 'MY_DS_KEY',
        });
        expect(cfg.driver).toMatchObject({
            type: 'pi-ai',
            provider: 'deepseek',
            model: 'deepseek-chat',
        });
        expect((cfg.driver as { apiKeyEnv?: string }).apiKeyEnv).toBe('MY_DS_KEY');
    });

    it('buildProviderConfig：scripted-demo 生成 scripted 驱动（无 key）', () => {
        const cfg = buildProviderConfig({ presetId: 'scripted-demo', model: 'scripted-1' });
        expect(cfg.driver).toMatchObject({ type: 'scripted' });
    });

    it('buildConfigFiles 生成三个文件内容且可写盘', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-cfgw-'));
        try {
            const gen = buildConfigFiles(dir, [
                { presetId: 'openai', model: 'gpt-4o-mini' },
                { presetId: 'deepseek', model: 'deepseek-chat' },
            ]);
            expect(gen.providers.map((p) => p.id)).toEqual(['openai', 'deepseek']);
            expect(gen.files.map((f) => f.name)).toEqual([
                'providers.json',
                'tools.json',
                'flags.json',
            ]);
            // 手动落盘验证（runConfigure 内部走 writeGenerated）
            for (const file of gen.files) {
                writeFileSync(join(dir, file.name), file.content);
            }
            expect(existsSync(join(dir, 'providers.json'))).toBe(true);
            const parsed = JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8'));
            expect(parsed.providers).toHaveLength(2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('envStatus：设置/未设置判定', () => {
        process.env.MAZI_TEST_ENV = 'abc';
        try {
            expect(envStatus('MAZI_TEST_ENV')).toBe('set');
            delete process.env.MAZI_TEST_ENV;
            expect(envStatus('MAZI_TEST_ENV')).toBe('unset');
        } finally {
            delete process.env.MAZI_TEST_ENV;
        }
    });
});
