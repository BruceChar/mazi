import { describe, expect, it, vi } from 'vitest';

// Browser stubs must exist before the store module is imported.
(globalThis as any).document = {
    documentElement: { dataset: {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, select: () => {}, value: '' }),
    body: { appendChild: () => {}, removeChild: () => {} },
};
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const writeText = vi.fn(async () => {});
Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText } },
    configurable: true,
    writable: true,
});

vi.mock('../src/api.js', () => ({
    API_BASE: '',
    logApi: () => {},
    api: vi.fn(async (path: string) =>
        path.includes('/thinking') ? { text: '1. hello\n\nfinal' } : [],
    ),
}));

// Avoid loading Vue's runtime-dom (the store only uses ref/reactive/computed).
vi.mock('vue', () => ({
    ref: (value: unknown) => ({ value }),
    reactive: (value: unknown) => value,
    computed: (fn: () => unknown) => ({
        get value() {
            return fn();
        },
    }),
    watch: () => () => {},
}));

const { copyThinkingChain } = await import('../src/scripts/store.ts');

describe('copyThinkingChain', () => {
    it('fetches the task thinking chain and writes it to the clipboard', async () => {
        writeText.mockClear();
        const text = await copyThinkingChain('run-1', 'task-1');
        expect(text).toBe('1. hello\n\nfinal');
        expect(writeText).toHaveBeenCalledWith('1. hello\n\nfinal');
    });
});
