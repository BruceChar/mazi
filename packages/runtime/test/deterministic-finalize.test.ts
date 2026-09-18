import { describe, expect, it } from 'vitest';

import {
    decideFinalize,
    type FinalizeResult,
    hasResultPlaceholder,
    renderResultTemplate,
} from '../src/gts/deterministic-finalize.js';

function result(overrides: Partial<FinalizeResult> = {}): FinalizeResult {
    return { callId: 'c', toolName: 't', output: 'out', isError: false, ...overrides };
}

describe('deterministic-finalize placeholders', () => {
    it('detects result placeholders', () => {
        expect(hasResultPlaceholder('answer: {{result}}')).toBe(true);
        expect(hasResultPlaceholder('answer: {{ result:1 }}')).toBe(true);
        expect(hasResultPlaceholder('no placeholder')).toBe(false);
    });

    it('renders a single result', () => {
        const rendered = renderResultTemplate('明天的天气是 {{result}}', [
            result({ output: '晴' }),
        ]);
        expect(rendered.text).toBe('明天的天气是 晴');
        expect(rendered.unresolved).toEqual([]);
    });

    it('renders multiple results by join, index and tool name', () => {
        const results = [
            result({ callId: 'a', toolName: 'ls', output: 'A' }),
            result({ callId: 'b', toolName: 'pwd', output: 'B' }),
        ];
        expect(renderResultTemplate('{{result}}', results).text).toBe('A\n\nB');
        expect(renderResultTemplate('{{result:1}} / {{result:2}}', results).text).toBe('A / B');
        expect(renderResultTemplate('{{result:pwd}}', results).text).toBe('B');
    });

    it('reports unresolved placeholders', () => {
        const rendered = renderResultTemplate('{{result:3}}', [result()]);
        expect(rendered.unresolved).toEqual(['{{result:3}}']);
    });
});

describe('deterministic-finalize decision', () => {
    it('finalizes when template and successful results line up', () => {
        expect(decideFinalize('**{{result}}**', [result({ output: 'ok' })])).toEqual({
            finalMessage: '**ok**',
        });
    });

    it('does not finalize without a placeholder or without results', () => {
        expect(decideFinalize('answer', [result()])).toBeUndefined();
        expect(decideFinalize('{{result}}', [])).toBeUndefined();
    });

    it('does not finalize on a failed result or an unresolved placeholder', () => {
        expect(decideFinalize('{{result}}', [result({ isError: true })])).toBeUndefined();
        expect(decideFinalize('{{result:2}}', [result()])).toBeUndefined();
    });
});
