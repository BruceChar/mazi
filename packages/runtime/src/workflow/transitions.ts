import type { Phase } from './types.js';

/**
 * 合法转移表（typestate 的运行时等价）。
 *
 * 表拦「非法转移」（Think→Think、Act→Act）；合法但可能空转的环
 * （Think→Plan→Think）由节点 requires 的进展条件拦。
 */
export const TRANSITIONS = {
    think: ['act', 'plan', 'verify'],
    act: ['observe'],
    observe: ['think', 'verify', 'reflect'],
    plan: ['think', 'act', 'verify'],
    verify: ['think', 'reflect'],
    reflect: ['plan', 'think'],
} as const satisfies Record<Phase, readonly Phase[]>;

export function canEnterPhase(from: Phase, to: Phase): boolean {
    return (TRANSITIONS[from] as readonly Phase[]).includes(to);
}

export class IllegalTransitionError extends Error {
    constructor(from: Phase, to: Phase) {
        super(`非法相位转移：${from} → ${to}`);
        this.name = 'IllegalTransitionError';
    }
}

export function assertTransition(from: Phase, to: Phase): void {
    if (!canEnterPhase(from, to)) throw new IllegalTransitionError(from, to);
}
