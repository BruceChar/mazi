import { describe, expect, it } from 'vitest';

import { deliberationRowDecision } from '../src/scripts/exec-tree.ts';

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
