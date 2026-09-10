import type { ContentType } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../../src/provider/config.js';
import { ConfigValidationError, KNOWN_SPECIALTIES, validateProviderConfig } from '../../src/provider/config.js';
import type { PricingSchedule } from '../../src/provider/pricing.js';

const caps = (over = {}) => ({
    supportsToolCalls: true,
    supportsStreaming: true,
    inputTypes: ['text'] as ContentType[],
    outputTypes: ['text'] as ContentType[],
    ...over,
});

function base(over: Partial<ProviderConfig> = {}): ProviderConfig {
    return {
        id: 'p1',
        adapter: 'deepseek',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        models: [{ id: 'm1', capabilities: caps() }],
        ...over,
    };
}

const env = { DEEPSEEK_API_KEY: 'sk-test' };

describe('validateProviderConfig（§9.2）', () => {
    it('合法配置：无警告（显式 apiKeyEnv 已在环境）', () => {
        const warnings = validateProviderConfig(base(), { env });
        expect(warnings).toEqual([]);
    });

    it('硬失败：adapter 缺失 / 未知 adapter 由 registry 报（此处仅非空）', () => {
        expect(() => validateProviderConfig(base({ adapter: '' }), { env })).toThrow(
            ConfigValidationError,
        );
    });

    it('faux 防线：未放行即失败', () => {
        expect(() => validateProviderConfig(base({ adapter: 'faux' }), { env })).toThrow(
            ConfigValidationError,
        );
        expect(validateProviderConfig(base({ adapter: 'faux' }), { env, allowFaux: true })).toEqual(
            [],
        );
    });

    it('硬失败：重复 model id、非法 capabilities、未知内容类型', () => {
        const dup = base({
            models: [
                { id: 'm1', capabilities: caps() },
                { id: 'm1', capabilities: caps() },
            ],
        });
        expect(() => validateProviderConfig(dup, { env })).toThrow(/duplicate model id/);
        const badCaps = base({
            models: [{ id: 'm1', capabilities: { supportsToolCalls: 'yes' } as never }],
        });
        expect(() => validateProviderConfig(badCaps, { env })).toThrow(/capabilities/);
        const badType = base({
            models: [{ id: 'm1', capabilities: caps({ inputTypes: ['video/x'] }) }],
        });
        expect(() => validateProviderConfig(badType, { env })).toThrow(/unknown content type/);
    });

    it('硬失败：pricing 单价 <=0、tier 非法、limits/timeoutMs 非正', () => {
        const pricing: PricingSchedule = {
            currency: 'USD',
            base: { inputPerMTok: 2, outputPerMTok: 0 },
            tiers: [],
            effectiveAt: 0,
            version: 'v1',
        };
        expect(() =>
            validateProviderConfig(
                base({ models: [{ id: 'm1', capabilities: caps(), pricing }] }),
                { env },
            ),
        ).toThrow(/outputPerMTok/);
        const badTier: PricingSchedule = {
            currency: 'USD',
            base: { inputPerMTok: 2, outputPerMTok: 10 },
            tiers: [{ name: 'x', windowHoursUtc: [5, 5], multiplier: 1 }],
            effectiveAt: 0,
            version: 'v1',
        };
        expect(() =>
            validateProviderConfig(
                base({ models: [{ id: 'm1', capabilities: caps(), pricing: badTier }] }),
                { env },
            ),
        ).toThrow(/windowHoursUtc/);
        expect(() => validateProviderConfig(base({ timeoutMs: -1 }), { env })).toThrow(/timeoutMs/);
        expect(() => validateProviderConfig(base({ limits: { rpm: 0 } }), { env })).toThrow(
            /limits/,
        );
    });

    it('硬失败：显式 apiKeyEnv 但环境缺失', () => {
        expect(() => validateProviderConfig(base(), { env: {} })).toThrow(/apiKeyEnv/);
    });

    it('警告：未知 specialty tag；本地端点无 key 提示', () => {
        const w = validateProviderConfig(
            base({
                apiKeyEnv: undefined,
                baseUrl: undefined,
                models: [{ id: 'm1', capabilities: caps(), tags: ['not-a-tag'] }],
            }),
            { env: {} },
        );
        expect(w.some((x) => x.kind === 'unknown-specialty')).toBe(true);
        expect(w.some((x) => x.kind === 'no-default-env')).toBe(true);
    });

    it('KNOWN_SPECIALTIES 非空且含常见值', () => {
        expect(KNOWN_SPECIALTIES).toContain('code-refactoring');
        expect(KNOWN_SPECIALTIES).toContain('summarization');
    });
});
