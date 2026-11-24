import type { Phase } from './types.js';

/**
 * 合法转移表（typestate 的运行时等价）。
 *
 */
export const TRANSITIONS = {
    router: ['plan', 'think'],
    plan: ['think', 'act', 'verify', 'negotiate'],
    negotiate: [],
    think: ['act', 'plan', 'verify', 'replan'],
    act: ['observe'],
    observe: ['think', 'verify', 'reflect', 'replan'],
    verify: ['think', 'reflect', 'replan'],
    reflect: ['replan', 'plan', 'think'],
    replan: ['think', 'plan'],
} as const satisfies Record<Phase, readonly Phase[]>;

export function canEnterPhase(from: Phase, to: Phase): boolean {
    return (TRANSITIONS[from] as readonly Phase[]).includes(to);
}

export class IllegalTransitionError extends Error {
    constructor(from: Phase, to: Phase) {
        super(`Illegal transition: ${from} → ${to}`);
        this.name = 'IllegalTransitionError';
    }
}

export function assertTransition(from: Phase, to: Phase): void {
    if (!canEnterPhase(from, to)) throw new IllegalTransitionError(from, to);
}
