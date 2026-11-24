import { describe, expect, it } from 'vitest';

import { bottom, type Op } from '../src/authz/v5/decision.js';
import { nonInteractiveDecide, Runbook } from '../src/authz/v5/runbook.js';

function op(fields: Partial<Op> = {}): Op {
    return {
        action: 'exec',
        target: 'deploy.sh',
        object: 'build_artifact',
        data: 'clean',
        q1: 'reversible',
        envelope: false,
        originChain: false,
        targetFresh: false,
        channel: 'non_interactive',
        attested: 'none',
        unparsed: false,
        ...fields,
    };
}

describe('运行清单（§12/D16）', () => {
    it('创建时逐条键入确认；未确认拒绝加入', () => {
        const book = new Runbook();
        expect(() => book.add({ key: 'deploy', summary: 'deploy.sh', typedConfirmed: false })).toThrow();
        book.add({ key: 'deploy', summary: 'deploy.sh', typedConfirmed: true });
        expect(book.allows('deploy')).toBe(true);
    });

    it('清单是唯一 hazard 免弹窗通道', () => {
        const book = new Runbook();
        book.add({ key: 'push', summary: 'git push', typedConfirmed: true });
        const hazardOp = op({ action: 'egress', target: 'origin', object: 'external', q1: 'irreversible' });
        expect(nonInteractiveDecide(hazardOp, book.allows('push'))).toBe('auto');
    });
});

describe('非交互 fail-closed（§12）', () => {
    it('§16 #24：非交互遇应弹窗操作 → deny + 留痕（清单外拒绝）', () => {
        const book = new Runbook();
        expect(nonInteractiveDecide(op(), book.allows('missing'))).toBe('deny');
    });

    it('清单不豁免 B1–B4：秘密即使在清单仍 deny', () => {
        const book = new Runbook();
        book.add({ key: 'secret-read', summary: 'read .env', typedConfirmed: true });
        const secretOp = op({ action: 'read', target: '.env', object: 'sensitive', data: 'secret' });
        expect(bottom(secretOp)).toBe('deny');
        expect(nonInteractiveDecide(secretOp, book.allows('secret-read'))).toBe('deny');
    });

    it('清单内可逆操作 → auto', () => {
        const book = new Runbook();
        book.add({ key: 'test', summary: 'pnpm test', typedConfirmed: true });
        expect(nonInteractiveDecide(op({ target: 'pnpm test' }), book.allows('test'))).toBe('auto');
    });
});
