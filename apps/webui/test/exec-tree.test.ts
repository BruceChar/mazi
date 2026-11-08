import { describe, expect, it } from 'vitest';

import {
    deliberationRowDecision,
    isDirectAnswerOnly,
    liveStepBodies,
    showContractCard,
    toggleCollapsedKey,
} from '../src/scripts/exec-tree.ts';

const base = { kind: 'deliberation', stepId: 's1' };

describe('exec-tree deliberation row decision', () => {
    it('renders a non-final deliberation with thinking or answer', () => {
        expect(deliberationRowDecision({ ...base, thinking: 'r' }, null)).toEqual({
            show: true,
            suppressIntent: false,
        });
        expect(deliberationRowDecision({ ...base, answer: 'a' }, null)).toEqual({
            show: true,
            suppressIntent: false,
        });
    });

    it('hides an empty non-final deliberation', () => {
        expect(deliberationRowDecision({ ...base }, null).show).toBe(false);
    });

    it('keeps the final-answer deliberation when it carries reasoning', () => {
        expect(deliberationRowDecision({ ...base, thinking: 'r', answer: 'a' }, 's1')).toEqual({
            show: true,
            suppressIntent: true,
        });
    });

    it('hides the final-answer deliberation when it has no reasoning', () => {
        expect(deliberationRowDecision({ ...base, answer: 'a' }, 's1').show).toBe(false);
    });

    it('always shows invocation steps', () => {
        expect(deliberationRowDecision({ kind: 'invocation', stepId: 'i1' }, null)).toEqual({
            show: true,
            suppressIntent: false,
        });
    });
});

describe('exec-tree live step bodies', () => {
    it('puts deliberation thinking and answer into their own slots', () => {
        expect(liveStepBodies({ kind: 'deliberation', thinking: 'r', answer: 'a' })).toEqual({
            thinking: 'r',
            answer: 'a',
            output: '',
        });
    });

    it('puts invocation output into the output slot', () => {
        expect(liveStepBodies({ kind: 'invocation', output: 'done' })).toEqual({
            thinking: '',
            answer: '',
            output: 'done',
        });
    });

    it('treats missing and null fields as empty text', () => {
        expect(liveStepBodies({ kind: 'deliberation' })).toEqual({
            thinking: '',
            answer: '',
            output: '',
        });
        expect(liveStepBodies({ kind: 'invocation', output: null })).toEqual({
            thinking: '',
            answer: '',
            output: '',
        });
    });

    it('never leaks fields across step kinds', () => {
        expect(liveStepBodies({ kind: 'deliberation', output: 'x' })).toEqual({
            thinking: '',
            answer: '',
            output: '',
        });
        expect(liveStepBodies({ kind: 'invocation', thinking: 'r' })).toEqual({
            thinking: '',
            answer: '',
            output: '',
        });
        expect(liveStepBodies({ kind: 'step', thinking: 'r', output: 'x' })).toEqual({
            thinking: '',
            answer: '',
            output: '',
        });
    });
});

describe('exec-tree collapse toggle', () => {
    it('adds a key that is not collapsed yet', () => {
        expect([...toggleCollapsedKey(new Set(), 'live-1')]).toEqual(['live-1']);
    });

    it('removes a key that is already collapsed', () => {
        expect([...toggleCollapsedKey(new Set(['live-1', 'live-2']), 'live-1')]).toEqual([
            'live-2',
        ]);
    });

    it('returns a new set and leaves the input untouched', () => {
        const input = new Set(['live-1']);
        const next = toggleCollapsedKey(input, 'live-2');
        expect(next).not.toBe(input);
        expect([...input]).toEqual(['live-1']);
    });
});

describe('exec-tree direct-route chrome', () => {
    it('hides contract chrome only for direct answers without execution facts', () => {
        const goal = {
            negotiation: { route: 'direct', directAnswer: '巴黎。' },
            tasks: [{ steps: [] }],
        };
        expect(isDirectAnswerOnly(goal)).toBe(true);
        expect(showContractCard(goal)).toBe(false);
    });

    it('shows the contract card on non-direct routes', () => {
        expect(showContractCard({ negotiation: { route: 'confirmed' } })).toBe(true);
        expect(showContractCard({ negotiation: { route: 'negotiate' } })).toBe(true);
        expect(showContractCard({ negotiation: { route: 'escalate' } })).toBe(true);
    });

    it('shows the contract card when negotiation is missing (legacy data)', () => {
        expect(showContractCard({})).toBe(true);
        expect(showContractCard(null)).toBe(true);
    });

    it('shows execution facts even when triage classified the goal as direct', () => {
        const withStartedTask = {
            negotiation: { route: 'direct', directAnswer: '巴黎。' },
            tasks: [{ startedAt: 1, steps: [] }],
        };
        const withStep = {
            negotiation: { route: 'direct', directAnswer: '巴黎。' },
            tasks: [{ steps: [{ stepId: 's1' }] }],
        };
        expect(isDirectAnswerOnly(withStartedTask)).toBe(false);
        expect(showContractCard(withStartedTask)).toBe(true);
        expect(isDirectAnswerOnly(withStep)).toBe(false);
        expect(showContractCard(withStep)).toBe(true);
    });

    it('does not treat a missing answer or non-direct route as direct-only', () => {
        expect(isDirectAnswerOnly({ negotiation: { route: 'direct' }, tasks: [] })).toBe(false);
        expect(
            isDirectAnswerOnly({
                negotiation: { route: 'confirmed', directAnswer: '巴黎。' },
                tasks: [],
            }),
        ).toBe(false);
        expect(isDirectAnswerOnly({})).toBe(false);
        expect(isDirectAnswerOnly(null)).toBe(false);
        expect(isDirectAnswerOnly(undefined)).toBe(false);
    });
});
