import type { FeatureFlagDefinition } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLAGS } from './default-flags.js';
import type { FlagContext } from './evaluator.js';
import { createFlagSnapshot, evaluateFlag, hashToBucket } from './evaluator.js';

const ctx: FlagContext = { sessionId: 'sess-abc' };

const boolFlag = (key: string, defaultValue: boolean): FeatureFlagDefinition<boolean> => ({
    key,
    description: '',
    type: 'boolean',
    defaultValue,
});

describe('flags 求值器（MVP v1.0 §8 F4）', () => {
    it('hashToBucket 稳定且落在 0-99', () => {
        for (const s of ['a', 'sess-1', '中文-session', 'zzzz']) {
            const b = hashToBucket(s);
            expect(Number.isInteger(b)).toBe(true);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(100);
        }
        expect(hashToBucket('sess-1')).toBe(hashToBucket('sess-1'));
    });

    it('无规则命中时返回默认值；规则按声明顺序优先', () => {
        const def: FeatureFlagDefinition<boolean> = {
            ...boolFlag('a', false),
            rules: [
                { match: { userIdIn: ['u2'] }, value: true, source: 'r-user2' },
                { match: { userIdIn: ['u1'] }, value: false, source: 'r-user1' },
            ],
        };
        // 默认
        expect(evaluateFlag(def, ctx)).toEqual({ value: false });
        // 命中第一条
        expect(evaluateFlag(def, { sessionId: 'x', userId: 'u1' })).toEqual({
            value: false,
            matchedRuleSource: 'r-user1',
        });
        expect(evaluateFlag(def, { sessionId: 'x', userId: 'u2' })).toEqual({
            value: true,
            matchedRuleSource: 'r-user2',
        });
    });

    it('bucketRange 规则用 sessionId 哈希分桶（A/B）', () => {
        const sessionId = 'ab-session';
        const bucket = hashToBucket(sessionId);
        const def: FeatureFlagDefinition<boolean> = {
            ...boolFlag('exp', false),
            rules: [{ match: { bucketRange: [bucket, bucket] }, value: true, source: 'exp-1' }],
        };
        expect(evaluateFlag(def, { sessionId })).toEqual({
            value: true,
            matchedRuleSource: 'exp-1',
        });
        expect(evaluateFlag(def, { sessionId: 'other' })).toEqual({ value: false });
    });

    it('goalTagIn / turnTagIn 交集匹配', () => {
        const def: FeatureFlagDefinition<string> = {
            key: 'route',
            description: '',
            type: 'string',
            defaultValue: 'v1',
            rules: [
                {
                    match: { goalTagIn: ['complex'], turnTagIn: ['tools'] },
                    value: 'v2',
                    source: 'sr',
                },
            ],
        };
        expect(
            evaluateFlag(def, { sessionId: 'x', goalTags: ['complex'], turnTags: ['tools'] }),
        ).toEqual({ value: 'v2', matchedRuleSource: 'sr' });
        expect(
            evaluateFlag(def, { sessionId: 'x', goalTags: ['simple'], turnTags: ['tools'] }),
        ).toEqual({
            value: 'v1',
        });
    });

    it('快照求值一次并冻结：值集合、trace、类型化查询', () => {
        const defs: FeatureFlagDefinition[] = [
            { key: 'console.sink', description: '', type: 'boolean', defaultValue: true },
            {
                key: 'user-profile.retention-days',
                description: '',
                type: 'number',
                defaultValue: 0,
            },
            {
                key: 'planner.routing-mode',
                description: '',
                type: 'string',
                defaultValue: 'simple',
            },
            boolFlag('user-profile.enabled', false),
        ];
        const snap = createFlagSnapshot(defs, ctx);
        expect(snap.isEnabled('console.sink')).toBe(true);
        expect(snap.isEnabled('user-profile.enabled')).toBe(false);
        expect(snap.getNumber('user-profile.retention-days')).toBe(0);
        expect(snap.getString('planner.routing-mode')).toBe('simple');
        expect(snap.getString('console.sink')).toBeUndefined();
        // 快照不可变
        expect(() => {
            (snap.values as Record<string, unknown>)['console.sink'] = false;
        }).toThrow();
        expect(snap.isEnabled('console.sink')).toBe(true);
        expect(snap.trace).toHaveLength(4);
        expect(snap.trace[0]).toMatchObject({ key: 'console.sink', resolvedValue: true });
    });

    it('默认 Flag 集覆盖 MVP 关键开关', () => {
        const keys = DEFAULT_FLAGS.map((f) => f.key);
        for (const k of [
            'console.sink',
            'observe.enabled',
            'user-profile.enabled',
            'user-profile.anonymize',
            'user-profile.retention-days',
            'planner.routing-mode',
            'strategy.auto-escalate',
        ]) {
            expect(keys).toContain(k);
        }
        const snap = createFlagSnapshot(DEFAULT_FLAGS, ctx);
        expect(snap.isEnabled('user-profile.enabled')).toBe(true);
        expect(snap.isEnabled('user-profile.anonymize')).toBe(false);
        expect(snap.getString('planner.routing-mode')).toBe('simple');
    });
});
