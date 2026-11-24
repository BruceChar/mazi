import { describe, expect, it } from 'vitest';

import { CorrectionLog, patternKeyOf, type PatternKey } from '../src/authz/v5/correction.js';
import { TraceStore } from '../src/authz/v5/trace-store.js';

const PATTERN: PatternKey = { action: 'write', objectClass: 'source', targetBinding: 'src/' };

describe('TraceStore 留痕（§10/D19）', () => {
    it('每次 auto 一条记录，可逐条撤销', () => {
        const store = new TraceStore();
        const a = store.record({ basis: 'routine', target: 'src/a.ts', detail: '例行命中' });
        store.record({ basis: 'memory', target: 'src/b.ts', detail: '指纹命中' });
        expect(store.list()).toHaveLength(2);
        expect(store.revoke(a.id)).toBe(true);
        expect(store.list()).toHaveLength(1);
    });
});

describe('纠正闭环（§10/D8）', () => {
    it('§16 #22：纠正 → 模式归零进红区，同目标绑定待审', () => {
        const log = new CorrectionLog();
        for (let i = 0; i < 5; i++) log.observe(PATTERN);
        const pending = log.recordCorrection(PATTERN, 'origin/main');
        expect(log.corrections(PATTERN)).toBe(1);
        expect(log.isFrozen(PATTERN)).toBe(true);
        expect(pending).toContain('origin/main');
    });

    it('§16 #23：模式纠正率 2% 超阈值 → 永久弹窗（降档只收紧）', () => {
        const log = new CorrectionLog();
        for (let i = 0; i < 100; i++) log.observe(PATTERN);
        log.recordCorrection(PATTERN, 'origin/main');
        log.recordCorrection(PATTERN, 'origin/main');
        expect(log.correctionRate(PATTERN)).toBeCloseTo(0.02);
        expect(log.isFrozen(PATTERN)).toBe(true);
    });

    it('零纠正模式不冻结', () => {
        const log = new CorrectionLog();
        for (let i = 0; i < 10; i++) log.observe(PATTERN);
        expect(log.isFrozen(PATTERN)).toBe(false);
    });

    it('patternKeyOf 稳定', () => {
        expect(patternKeyOf(PATTERN)).toBe(patternKeyOf({ ...PATTERN }));
    });
});
