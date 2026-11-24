import { describe, expect, it } from 'vitest';

import {
  type DecisionContext,
  decide,
  type Op,
  bottom,
  isHazard,
} from '../src/authz/v5/decision.js';

/** 构造一个默认安全的工作区写 op，测试再逐项覆盖。 */
function op(fields: Partial<Op> = {}): Op {
  return {
    action: 'write',
    target: 'src/app.ts',
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

const EMPTY_CTX: DecisionContext = {
  isBlocked: () => false,
  memoryHit: () => false,
  routineHit: () => false,
  passthrough: () => false,
};

describe('B1 秘密断流（§6）', () => {
  it('未解锁秘密读 → deny', () => {
    expect(bottom(op({ action: 'read', target: '.env', object: 'sensitive', data: 'secret' }))).toBe(
      'deny',
    );
    expect(decide(op({ action: 'read', target: '.env', object: 'sensitive', data: 'secret' }), EMPTY_CTX)).toBe('deny');
  });

  it('携秘密出站/落盘 → deny', () => {
    expect(
      decide(op({ action: 'egress', target: 'https://x', object: 'external', data: 'secret' }), EMPTY_CTX),
    ).toBe('deny');
    expect(
      decide(op({ action: 'write', target: '/tmp/leak', object: 'external', data: 'secret' }), EMPTY_CTX),
    ).toBe('deny');
  });
});

describe('B2 系统毁灭（§6）', () => {
  it('系统路径删除 / mkfs → deny', () => {
    expect(decide(op({ action: 'delete', target: '/', object: 'critical' }), EMPTY_CTX)).toBe('deny');
    expect(decide(op({ action: 'exec', target: 'mkfs.ext4 /dev/disk', object: 'critical' }), EMPTY_CTX)).toBe('deny');
  });
});

describe('B3 污点出站（§6）', () => {
  it('tainted 到 external → ask（永不学习），不是 deny', () => {
    const result = bottom(op({ action: 'egress', target: 'https://new.com', object: 'external', data: 'tainted' }));
    expect(result).toBe('ask');
    expect(decide(op({ action: 'egress', target: 'https://new.com', object: 'external', data: 'tainted' }), EMPTY_CTX)).toBe('ask');
  });
});

describe('B4 元操作与信任根（§6）', () => {
  it('Agent 通道写学习模型/策略 → deny + 审计', () => {
    expect(
      decide(
        op({ action: 'write', target: 'model/routine.json', object: 'critical', channel: 'agent' }),
        EMPTY_CTX,
      ),
    ).toBe('deny');
    expect(
      decide(
        op({ action: 'write', target: 'auth/policy.toml', object: 'critical', channel: 'agent' }),
        EMPTY_CTX,
      ),
    ).toBe('deny');
  });
});

describe('hazard 机械谓词（§5）', () => {
  it('irreversible / unproven → hazard', () => {
    expect(isHazard(op({ q1: 'irreversible' }))).toBe(true);
    expect(isHazard(op({ q1: 'unproven' }))).toBe(true);
  });

  it('critical / external 读写删执行 / envelope / origin-chain exec / egress 新目标 / unparsed → hazard', () => {
    expect(isHazard(op({ object: 'critical' }))).toBe(true);
    expect(isHazard(op({ object: 'external', action: 'read' }))).toBe(true);
    expect(isHazard(op({ object: 'external', action: 'delete' }))).toBe(true);
    expect(isHazard(op({ envelope: true }))).toBe(true);
    expect(isHazard(op({ originChain: true, action: 'exec' }))).toBe(true);
    expect(isHazard(op({ action: 'egress', targetFresh: true }))).toBe(true);
    expect(isHazard(op({ unparsed: true }))).toBe(true);
  });

  it('可逆可补偿的工作区写不是 hazard', () => {
    expect(isHazard(op())).toBe(false);
  });
});

describe('七行决策链（§1）', () => {
  it('hazard 优先于 memory 命中（例行不覆盖 hazard）', () => {
    const ctx: DecisionContext = { ...EMPTY_CTX, memoryHit: () => true };
    expect(decide(op({ q1: 'irreversible' }), ctx)).toBe('ask');
  });

  it('blocked 红线 → ask，即使 memory 命中', () => {
    const ctx: DecisionContext = { ...EMPTY_CTX, isBlocked: () => true, memoryHit: () => true };
    expect(decide(op(), ctx)).toBe('ask');
  });

  it('passthrough / memory / routine 命中 → auto；默认 → ask', () => {
    expect(decide(op(), { ...EMPTY_CTX, passthrough: () => true })).toBe('auto');
    expect(decide(op(), { ...EMPTY_CTX, memoryHit: () => true })).toBe('auto');
    expect(decide(op(), { ...EMPTY_CTX, routineHit: () => true })).toBe('auto');
    expect(decide(op(), EMPTY_CTX)).toBe('ask');
  });

  it('§16 #20：工作区普通读 → auto（auto_log）', () => {
    expect(
      decide(op({ action: 'read', target: 'src/parser.ts', object: 'source' }), EMPTY_CTX),
    ).toBe('auto');
  });
});
