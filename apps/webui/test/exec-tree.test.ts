import { describe, expect, it } from 'vitest';

import {
    deliberationRowDecision,
    isDirectRoute,
    showContractCard,
    stepDefaultCollapsed,
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

describe('exec-tree step default collapse', () => {
    it('collapses deliberation (thinking) rows by default', () => {
        expect(stepDefaultCollapsed({ kind: 'deliberation' })).toBe(true);
    });

    it('keeps invocation (tool output) rows expanded by default', () => {
        expect(stepDefaultCollapsed({ kind: 'invocation' })).toBe(false);
    });

    it('does not collapse unknown step kinds', () => {
        expect(stepDefaultCollapsed({ kind: 'step' })).toBe(false);
    });
});

describe('exec-tree direct-route chrome', () => {
    it('hides the contract card for direct-route goals', () => {
        expect(showContractCard({ negotiation: { route: 'direct' } })).toBe(false);
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

    it('detects direct routes for hiding task blocks', () => {
        expect(isDirectRoute({ negotiation: { route: 'direct' } })).toBe(true);
        expect(isDirectRoute({ negotiation: { route: 'confirmed' } })).toBe(false);
        expect(isDirectRoute({})).toBe(false);
        expect(isDirectRoute(null)).toBe(false);
        expect(isDirectRoute(undefined)).toBe(false);
    });
});
