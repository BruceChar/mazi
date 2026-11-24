import { describe, expect, it } from 'vitest';

import { MIN_OBSERVATIONS, RoutineModel, type RoutinePatternInput } from '../src/authz/v5/routine-model.js';

const PUSH: RoutinePatternInput = {
    action: 'exec',
    objectClass: 'source',
    targetBinding: 'origin/main',
    q1: 'compensable',
};

function train(model: RoutineModel, pattern: RoutinePatternInput, times: number): void {
    for (let i = 0; i < times; i++) model.observe(pattern);
}

describe('routine 学习层（§9/D7）', () => {
    it('§16 #2：重复 ≥5 次零纠正低方差可逆 → routine；不足次数仍问', () => {
        const model = new RoutineModel();
        train(model, PUSH, MIN_OBSERVATIONS - 1);
        expect(model.isRoutine(PUSH, { hazard: false })).toBe(false);
        model.observe(PUSH);
        expect(model.isRoutine(PUSH, { hazard: false })).toBe(true);
    });

    it('§16 #12：已学 remote 的 compensable push → routine', () => {
        const model = new RoutineModel();
        train(model, PUSH, 6);
        expect(model.isRoutine(PUSH, { hazard: false })).toBe(true);
    });

    it('§16 #14：hazard（新 remote / irreversible）永不进例行', () => {
        const model = new RoutineModel();
        train(model, PUSH, 6);
        expect(model.isRoutine(PUSH, { hazard: true })).toBe(false);
    });

    it('§16 #21：新颖模式无观测 → 不乐观填充，必问', () => {
        const model = new RoutineModel();
        expect(model.isRoutine({ ...PUSH, targetBinding: 'new-remote/main' }, { hazard: false })).toBe(false);
    });

    it('§16 #17：污点会话批准事件不进模型（输入隔离）', () => {
        const model = new RoutineModel();
        train(model, { ...PUSH, taintedSource: true }, 8);
        expect(model.isRoutine(PUSH, { hazard: false })).toBe(false);
    });

    it('有纠正 → 不 routine（归零重学）', () => {
        const model = new RoutineModel();
        train(model, PUSH, 6);
        model.recordCorrection(PUSH);
        expect(model.isRoutine(PUSH, { hazard: false })).toBe(false);
    });

    it('irreversible / unproven q1 → 不 routine', () => {
        const model = new RoutineModel();
        train(model, { ...PUSH, q1: 'irreversible' }, 6);
        expect(model.isRoutine({ ...PUSH, q1: 'irreversible' }, { hazard: false })).toBe(false);
    });

    it('高方差 → 不 routine', () => {
        const model = new RoutineModel();
        train(model, { ...PUSH, variance: 'high' }, 6);
        expect(model.isRoutine({ ...PUSH, variance: 'high' }, { hazard: false })).toBe(false);
    });
});
