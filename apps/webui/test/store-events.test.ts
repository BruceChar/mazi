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
    // The store registers one module-level watcher (session permission).
    watch: () => () => {},
}));

const { liveSteps, runDetails, stopEvents, watchEvents } = await import('../src/scripts/store.ts');

describe('webui live step refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeEventSource.instances.length = 0;
    });
    afterEach(() => {
        stopEvents();
        vi.useRealTimers();
    });

    it('goal.ended refreshes the per-run snapshot the chat renders (runDetails)', async () => {
        watchEvents('run-1');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('goal.ended', {
            eventId: 'e1',
            type: 'goal.ended',
            payload: { outcome: { status: 'success' } },
        });
        await vi.advanceTimersByTimeAsync(300);
        expect(runDetails['run-1']).toBeTruthy();
        expect(runDetails['run-1']?.stepCount).toBe(1);
        expect(runDetails['run-1']?.goals[0]?.tasks[0]?.steps[0]?.stepId).toBe('s1');
    });

    it('live steps append on step.started and close the previous running step', () => {
        watchEvents('run-2');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('step.started', {
            eventId: 's1',
            type: 'step.started',
            taskId: 't1',
            stepId: 'a',
            payload: { kind: 'tool_call', status: 'running', content: 'read README' },
        });
        source.emit('step.started', {
            eventId: 's2',
            type: 'step.started',
            taskId: 't1',
            stepId: 'b',
            payload: { kind: 'thinking', status: 'ok', content: 'next thought' },
        });
        expect(liveSteps['run-2']?.map((step) => step.stepId)).toEqual(['a', 'b']);
        // Starting b closes a (the "next step starts, previous ends" rule).
        expect(liveSteps['run-2']?.[0]?.status).toBe('ok');
        expect(liveSteps['run-2']?.[0]?.endedAt).not.toBeNull();
    });

    it('step.ended updates the running tool call in place (no duplicate row)', () => {
        watchEvents('run-3');
        const source = FakeEventSource.instances.at(-1)!;
        source.emit('step.started', {
            eventId: 's1',
            type: 'step.started',
            taskId: 't1',
            stepId: 'a',
            payload: { kind: 'tool_call', status: 'running', content: 'read README' },
        });
        source.emit('step.ended', {
            eventId: 's2',
            type: 'step.ended',
            taskId: 't1',
            stepId: 'a',
            payload: { kind: 'tool_call', status: 'ok', content: 'read README' },
        });
        expect(liveSteps['run-3']).toHaveLength(1);
        expect(liveSteps['run-3']?.[0]?.status).toBe('ok');
    });
});
