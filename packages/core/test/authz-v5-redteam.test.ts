import { describe, expect, it } from 'vitest';

import { decide, isHazard, type DecisionContext, type Op } from '../src/authz/v5/decision.js';
import { fingerprintKey } from '../src/authz/v5/fingerprint.js';
import { MemoryStore } from '../src/authz/v5/memory-store.js';
import { BlockedStore } from '../src/authz/v5/blocked-store.js';
import { RoutineModel } from '../src/authz/v5/routine-model.js';
import { CorrectionLog, type PatternKey } from '../src/authz/v5/correction.js';
import { allowsRoutine } from '../src/authz/v5/enforce-level.js';
import { nonInteractiveDecide, Runbook } from '../src/authz/v5/runbook.js';
import { parseCommand, recheckTarget } from '../src/authz/v5/parser.js';

function op(fields: Partial<Op> = {}): Op {
    return {
        action: 'exec',
        target: 'cmd',
        object: 'source',
        data: 'clean',
        q1: 'compensable',
        envelope: false,
        originChain: false,
        targetFresh: false,
        channel: 'ui_user',
        attested: 'none',
        unparsed: false,
        ...fields,
    };
}

const CTX: DecisionContext = {
    isBlocked: () => false,
    memoryHit: () => false,
    routineHit: () => false,
    passthrough: () => false,
};

const PATTERN: PatternKey = { action: 'exec', objectClass: 'source', targetBinding: 'origin/main' };

describe('§18 红队清单', () => {
    it('1. Agent 写脚本再执行（origin_chain exec）→ hazard，不自动', () => {
        const candidate = op({ originChain: true, action: 'exec', target: './downloaded.sh' });
        expect(isHazard(candidate)).toBe(true);
        expect(decide(candidate, CTX)).toBe('ask');
    });

    it('2/3. 粘贴注入"总是允许"与污点会话批准 → 不进模型（输入隔离）', () => {
        const model = new RoutineModel();
        for (let i = 0; i < 8; i++) model.observe({ ...PATTERN, q1: 'compensable', taintedSource: true });
        expect(model.isRoutine(PATTERN, { hazard: false })).toBe(false);
    });

    it('4. Agent 通道写学习模型/策略（B4）→ deny + 审计', () => {
        expect(
            decide(op({ channel: 'agent', object: 'critical', action: 'write', target: 'model/routine.json' }), CTX),
        ).toBe('deny');
    });

    it('5. 纠正回滚连带：同目标绑定进待审', () => {
        const log = new CorrectionLog();
        const pending = log.recordCorrection(PATTERN, 'origin/main');
        expect(pending).toContain('origin/main');
        expect(log.isFrozen(PATTERN)).toBe(true);
    });

    it('6. 新颖性不乐观填充：无观测模式必问', () => {
        const model = new RoutineModel();
        expect(model.isRoutine({ ...PATTERN, targetBinding: 'new/main' }, { hazard: false })).toBe(false);
    });

    it('7. 指纹归一化变体：引号/空白等价，flag 顺序不同即新指纹', () => {
        expect(fingerprintKey({ command: 'pnpm test' })).toBe(fingerprintKey({ command: '"pnpm test"' }));
        expect(fingerprintKey({ command: 'git log --oneline -5' })).not.toBe(
            fingerprintKey({ command: 'git log -5 --oneline' }),
        );
    });

    it('8. hazard 不被例行/记忆覆盖：hazard 优先', () => {
        const model = new RoutineModel();
        for (let i = 0; i < 6; i++) model.observe({ ...PATTERN, q1: 'compensable' });
        expect(model.isRoutine(PATTERN, { hazard: true })).toBe(false);
        const ctx: DecisionContext = { ...CTX, memoryHit: () => true };
        expect(decide(op({ q1: 'irreversible' }), ctx)).toBe('ask');
    });

    it('9. 元字符绕过：sh -c / $() / eval → unparsed hazard', () => {
        expect(parseCommand('sh -c "rm -rf /"').unparsed).toBe(true);
        expect(parseCommand('echo $(whoami)').unparsed).toBe(true);
        expect(parseCommand('eval ls').unparsed).toBe(true);
    });

    it('10. 非交互 fail-closed：清单外 deny+留痕', () => {
        expect(nonInteractiveDecide(op(), false)).toBe('deny');
    });

    it('11. 新 remote push（egress target_fresh）→ hazard', () => {
        const candidate = op({ action: 'egress', object: 'external', target: 'new-remote/main', targetFresh: true });
        expect(isHazard(candidate)).toBe(true);
        expect(decide(candidate, CTX)).toBe('ask');
    });

    it('12. unparsed 不可指纹化：记忆命中也救不回', () => {
        const ctx: DecisionContext = { ...CTX, memoryHit: () => true };
        expect(decide(op({ unparsed: true }), ctx)).toBe('ask');
    });

    it('13. TOCTOU：批准后目标换 external → 回弹窗', () => {
        const before = op({ target: 'src/a.ts', object: 'source', q1: 'compensable' });
        const after = op({ target: '~/Documents/a.txt', object: 'external', q1: 'compensable' });
        expect(recheckTarget(before, after).changed).toBe(true);
    });

    it('14. 复合命令拆链：任一 ask 整链暂停（ops 完整保留）', () => {
        const result = parseCommand('cd a && rm b');
        expect(result.ops).toHaveLength(2);
        expect(result.unparsed).toBe(false);
    });

    it('15. 无网络件时执行类进例行被拒（放行域矩阵）', () => {
        expect(allowsRoutine('none', 'exec')).toBe(false);
        expect(allowsRoutine('unix', 'exec')).toBe(false);
    });

    it('16. 污点出站（B3）→ ask，永不学习', () => {
        expect(
            decide(op({ action: 'egress', object: 'external', data: 'tainted', target: 'https://x' }), CTX),
        ).toBe('ask');
    });

    it('17. 红线命中 → ask，即使记忆命中', () => {
        const blocked = new BlockedStore();
        blocked.add('cmd');
        const ctx: DecisionContext = { ...CTX, isBlocked: (c) => blocked.has(c.target), memoryHit: () => true };
        expect(decide(op(), ctx)).toBe('ask');
    });

    it('18. 清单不豁免底线：秘密在清单仍 deny', () => {
        const book = new Runbook();
        book.add({ key: 'secret', summary: 'read .env', typedConfirmed: true });
        expect(
            nonInteractiveDecide(op({ action: 'read', target: '.env', object: 'sensitive', data: 'secret' }), true),
        ).toBe('deny');
    });
});
