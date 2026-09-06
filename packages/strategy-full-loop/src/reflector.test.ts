import { describe, expect, it } from 'vitest';
import { MechanicalReflector } from './reflector.js';

describe('MechanicalReflector（独立反射）', () => {
    it('返回通过/失败条件与结论', async () => {
        const verdict = await new MechanicalReflector().reflect({
            sessionId: 's',
            turnId: 't',
            success: { conditions: ['contains:完成', 'contains:报价'], description: '' },
            outcomeOk: true,
            finalMessage: '任务完成，报价 100 元',
        });
        expect(verdict.accepted).toBe(true);
        expect(verdict.failedConditions).toEqual([]);
    });

    it('未满足条件时 accepted=false 并列出失败项', async () => {
        const verdict = await new MechanicalReflector().reflect({
            sessionId: 's',
            turnId: 't',
            success: { conditions: ['contains:完成', 'contains:报价'], description: '' },
            outcomeOk: true,
            finalMessage: '什么都没给',
        });
        expect(verdict.accepted).toBe(false);
        expect(verdict.failedConditions).toEqual(['contains:完成', 'contains:报价']);
    });
});
