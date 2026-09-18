import { describe, expect, it } from 'vitest';

import type { ResolvedLabel } from '../src/authz/labels.js';
import { assessQuestions, matchDangerVerb } from '../src/authz/risk.js';
import type { Question, SensitivityLabel, ToolSemantics, ValueProjection } from '../src/authz/types.js';

function target(
    partial: Partial<{ label: SensitivityLabel; boundary: boolean }> = {},
): ResolvedLabel {
    return { label: 'internal', boundary: false, specificity: 0, matches: [], ...partial };
}

function assess(
    capability: string,
    semantics: ToolSemantics,
    projection: ValueProjection = {},
    resolved: ResolvedLabel = target(),
) {
    return assessQuestions({ capability, semantics, projection, target: resolved });
}

function questions(capability: string, semantics: ToolSemantics): Question[] {
    return assess(capability, semantics).questions.map((q) => q.question);
}

describe('authz three-question risk model', () => {
    it('Q1: a declared irreversible operation raises the floor to gated', () => {
        const result = assess('pay', { irreversible: true });
        expect(result.floor).toBe('gated');
        expect(questions('pay', { irreversible: true })).toContain('Q1');
    });

    it('Q1: the value layer recognizes an irreversible verb', () => {
        const matches = matchDangerVerb('rm -rf src/');
        expect(matches.map((m) => m.verb)).toContain('rm');
        const result = assess('fs.exec', {}, { command: 'rm -rf src/' });
        expect(result.floor).toBe('gated');
        expect(result.questions.map((q) => q.question)).toContain('Q1');
    });

    it('Q2: an ingest raises no tier floor by itself', () => {
        const result = assess('fs.read.workspace', { ingest: true });
        expect(result.floor).toBe('auto');
        expect(questions('fs.read.workspace', { ingest: true })).toEqual(['Q2']);
    });

    it('Q3: a boundary write raises the floor to gated', () => {
        const result = assess('fs.write.workspace', {}, {}, target({ boundary: true }));
        expect(result.floor).toBe('gated');
        expect(result.questions.map((q) => q.question)).toContain('Q3');
    });

    it('Q3 does not fire on a boundary read', () => {
        const result = assess('fs.read.workspace', { ingest: true }, {}, target({ boundary: true }));
        expect(result.floor).toBe('auto');
    });

    it('hard floor: a secret write is forbidden', () => {
        const result = assess('fs.write.workspace', {}, {}, target({ label: 'secret' }));
        expect(result.hard).toBe('forbidden');
        expect(result.hardReason).toContain('秘密级');
    });
});
