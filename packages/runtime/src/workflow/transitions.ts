import type { Phase } from './types.js';

/**
 * 合法转移表（typestate 的运行时等价）。
 *
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
        super(`Illegal transition: ${from} → ${to}`);
        this.name = 'IllegalTransitionError';
    }
}

export function assertTransition(from: Phase, to: Phase): void {
    if (!canEnterPhase(from, to)) throw new IllegalTransitionError(from, to);
}
