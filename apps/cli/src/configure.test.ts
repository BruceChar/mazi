import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildConfigFiles,
    buildProviderConfig,
    envStatus,
    mergeModelChoices,
    PROVIDER_PRESETS,
    resolveModelAnswer,
    resolvePresetSelections,
} from './configure.js';

describe('交互式配置纯函数（mazi config）', () => {
    it('resolvePresetSelections：数字/逗号/空格/id 均可解析且去重', () => {
        expect(resolvePresetSelections('1,2', PROVIDER_PRESETS)).toEqual(['openai', 'deepseek']);
        expect(resolvePresetSelections('3 1', PROVIDER_PRESETS)).toEqual(['openai']);
        expect(resolvePresetSelections('deepseek,openai', PROVIDER_PRESETS)).toEqual([
            'deepseek',
            'openai',
        ]);
        expect(resolvePresetSelections('99', PROVIDER_PRESETS)).toEqual([]);
        expect(resolvePresetSelections('2,2,3', PROVIDER_PRESETS)).toEqual(['deepseek']);
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
            model: 'deepseek-v4-flash',
            keyEnv: 'MY_DS_KEY',
        });
        expect(cfg.driver).toMatchObject({
            type: 'pi-ai',
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
        });
        expect((cfg.driver as { apiKeyEnv?: string }).apiKeyEnv).toBe('MY_DS_KEY');
    });

    it('DeepSeek 预设仅包含 pi-ai v4 目录模型（deepseek-chat/reasoner 已退役）', () => {
        const preset = PROVIDER_PRESETS.find((p) => p.id === 'deepseek');
        expect(preset?.models.map((m) => m.id)).toEqual([
            'deepseek-v4-flash',
            'deepseek-v4-flash-vision-exp',
            'deepseek-v4-pro',
        ]);
        expect(preset?.defaultModel).toBe('deepseek-v4-flash');
    });

    it('buildConfigFiles 生成三个文件内容且可写盘', () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-cfgw-'));
        try {
            const gen = buildConfigFiles(dir, [
                { presetId: 'openai', model: 'gpt-4o-mini' },
                { presetId: 'deepseek', model: 'deepseek-v4-flash' },
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

    it('mergeModelChoices：动态 + 回退提示去重排序（U3）', () => {
        const merged = mergeModelChoices(['gpt-4o', 'gpt-5'], ['gpt-4o-mini', 'gpt-4o']);
        expect(merged).toEqual(['gpt-4o', 'gpt-4o-mini', 'gpt-5']);
    });

    it('resolveModelAnswer：空→fallback；数字→序号；否则字面 id', () => {
        const choices = ['a-model', 'b-model'];
        expect(resolveModelAnswer('', choices, 'a-model')).toBe('a-model');
        expect(resolveModelAnswer('2', choices, 'x')).toBe('b-model');
        expect(resolveModelAnswer('999', choices, 'x')).toBe('999');
        expect(resolveModelAnswer('a-model', choices, 'x')).toBe('a-model');
        expect(resolveModelAnswer('custom-id', choices, 'x')).toBe('custom-id');
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
