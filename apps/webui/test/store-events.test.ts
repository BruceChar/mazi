import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Browser stubs. Must exist before the store module is imported, so the
// store is loaded with a dynamic import at the bottom (imports are hoisted). ---
(globalThis as any).document = { documentElement: { dataset: {} }, getElementById: () => null };
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, cb: (event: { data: string }) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
    }
    close(): void {}
    emit(type: string, data: unknown): void {
        for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
    }
}
(globalThis as any).EventSource = FakeEventSource;

const snapshot = {
    rootGoalId: 'run-1',
    goals: [
        {
            goalId: 'g1',
            kind: 'work',
            status: 'active',
            statement: 'do it',
            tasks: [
                {
                    taskId: 't1',
                    status: 'running',
                    title: 'do it',
                    steps: [{ stepId: 's1', kind: 'tool_call', status: 'ok', startedAt: 1, endedAt: 2 }],
                },
            ],
        },
    ],
    taskCount: 1,
    stepCount: 1,
};

vi.mock('../src/api.js', () => ({
    API_BASE: '',
    logApi: () => {},
    api: vi.fn(async (path: string) => (path.includes('/timeline') ? snapshot : [])),
}));

// Avoid loading Vue's runtime-dom (it requires a full DOM); the store only uses
// ref/reactive/computed, so minimal stubs are enough to exercise its logic.
vi.mock('vue', () => ({
    ref: (value: unknown) => ({ value }),
    reactive: (value: unknown) => value,
    computed: (fn: () => unknown) => ({
        get value() {
            return fn();
        },
    }),
}));

const { runDetails, stopEvents, watchEvents } = await import('../src/scripts/store.ts');

describe('webui live step refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.instances.length = 0;
    });
    afterEach(() => {
        stopEvents();
        vi.useRealTimers();
    });

    it('a live step.ended refreshes the per-run snapshot the chat renders (runDetails)', async () => {
        watchEvents('run-1');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('step.ended', {
            eventId: 'e1',
            type: 'step.ended',
            taskId: 't1',
            stepId: 's1',
            payload: { kind: 'tool_call', status: 'ok' },
        });
        await vi.advanceTimersByTimeAsync(300);
        expect(runDetails['run-1']).toBeTruthy();
        expect(runDetails['run-1']?.stepCount).toBe(1);
        expect(runDetails['run-1']?.goals[0]?.tasks[0]?.steps[0]?.stepId).toBe('s1');
    });
});
