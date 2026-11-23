import type { Fault } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { DefaultFaultPipeline, parseCode, toFault, toFaultFromResult } from '../src/faults/index.js';

const ids = { rootGoalId: 'g1', sessionId: 's1' };

function fault(overrides: Partial<Fault> = {}): Fault {
    return {
        faultId: 'f1',
        domain: 'tool',
        kind: 'timeout',
        severity: 'recoverable',
        scope: 'call',
        retryable: true,
        idempotent: true,
        key: 'tool:fs.read:{"path":"a"}',
        message: '超时',
        identifiers: ids,
        ...overrides,
    };
}

describe('FaultPipeline（§4 恢复阶梯 / §5 策略表）', () => {
    it('幂等超时先同参重试一次，用尽后降级', () => {
        const p = new DefaultFaultPipeline();
        expect(p.decide(fault())).toMatchObject({ action: 'retry', attempt: 1, reason: 'policy' });
        expect(p.decide(fault())).toMatchObject({
            action: 'degrade',
            attempt: 2,
            reason: 'attempts-exhausted',
        });
    });

    it('非幂等超时不重试（避免重复副作用）', () => {
        const p = new DefaultFaultPipeline();
        const recovery = p.decide(fault({ idempotent: false }));
        expect(recovery).toMatchObject({ action: 'degrade', attempt: 1, reason: 'non-idempotent' });
        expect(p.attemptsOf('tool:fs.read:{"path":"a"}')).toBe(1);
    });

    it('瞬时错误指数退避两次后升级到 turn', () => {
        const p = new DefaultFaultPipeline();
        const f = fault({ kind: 'transient', idempotent: true });
        expect(p.decide(f)).toMatchObject({ action: 'retry', delayMs: 100 });
        expect(p.decide(f)).toMatchObject({ action: 'retry', delayMs: 200 });
        expect(p.decide(f)).toMatchObject({
            action: 'escalate',
            escalateTo: 'turn',
            reason: 'attempts-exhausted',
        });
    });

    it('参数错误零重试，直接交回模型改参', () => {
        const p = new DefaultFaultPipeline();
        const recovery = p.decide(
            fault({ kind: 'invalid_args', severity: 'degradable', retryable: false }),
        );
        expect(recovery).toMatchObject({ action: 'retry_altered', attempt: 1 });
        expect(recovery.maxRetries).toBe(0);
    });

    it('权限拒绝中止；fatal 无视任何域策略', () => {
        const p = new DefaultFaultPipeline({
            domains: { tool: { policy_denied: { onGiveUp: 'degrade' } } },
        });
        // 域覆盖优先于基线：默认 abort，覆盖成 degrade 后按 degrade 走。
        expect(p.decide(fault({ kind: 'policy_denied' })).action).toBe('degrade');
        expect(new DefaultFaultPipeline().decide(fault({ kind: 'policy_denied' })).action).toBe(
            'abort',
        );
        expect(p.decide(fault({ kind: 'internal', severity: 'fatal' }))).toMatchObject({
            action: 'abort',
            reason: 'fatal',
        });
    });

    it('域覆盖生效，reset 清计数并返回旧值', () => {
        const p = new DefaultFaultPipeline({
            domains: { tool: { timeout: { maxRetries: 0 } } },
        });
        expect(p.decide(fault()).action).toBe('degrade');
        p.reset(fault().key as string);
        expect(p.decide(fault()).action).toBe('degrade');
        p.reset(fault().key as string);
        p.decide(fault());
        expect(p.reset(fault().key as string)).toBe(1);
        expect(p.attemptsOf(fault().key as string)).toBe(0);
    });

    it('每次决策都广播 fault.raised，广播抛出不影响结论', () => {
        const raised: string[] = [];
        const p = new DefaultFaultPipeline({
            emit: (type, f, recovery) => {
                raised.push(`${type}:${f.kind}:${recovery?.action ?? ''}`);
                throw new Error('sink down');
            },
        });
        expect(p.decide(fault()).action).toBe('retry');
        expect(raised).toEqual(['fault.raised:timeout:retry']);
    });
});

describe('归一化（§3 契约）', () => {
    it('工具实现抛 TypeError 归 internal，不升级为 fatal', () => {
        const f = toFault(new TypeError('boom'), {
            domain: 'tool',
            key: 'tool:x:{}',
            identifiers: ids,
        });
        expect(f).toMatchObject({ domain: 'tool', kind: 'internal', severity: 'degradable' });
    });

    it('非工具域的同名类型错误按编程缺陷处理', () => {
        const f = toFault(new TypeError('boom'), { domain: 'planner' });
        expect(f.severity).toBe('fatal');
    });

    it('网关错误串拆出 code，缺参归 invalid_args', () => {
        expect(parseCode('INVALID_ARGS: 缺少必填参数：path')).toEqual({
            code: 'INVALID_ARGS',
            message: '缺少必填参数：path',
        });
        const f = toFaultFromResult({ error: 'INVALID_ARGS: 缺少必填参数：path' }, {
            domain: 'tool',
            key: 'tool:x:{}',
        });
        expect(f).toMatchObject({ kind: 'invalid_args', code: 'INVALID_ARGS' });
    });
});
