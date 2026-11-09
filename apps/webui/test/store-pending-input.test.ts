import { describe, expect, it, vi } from 'vitest';

// Minimal browser/vue stubs so the store module can be imported outside the app.
(globalThis as any).document = { documentElement: { dataset: {} }, getElementById: () => null };
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

vi.mock('../src/api.js', () => ({
    API_BASE: '',
    logApi: () => {},
    api: vi.fn(async () => ({})),
}));
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

const {
    busy,
    createRun,
    current,
    currentConversation,
    executionQueue,
    pendingInput,
} = await import('../src/scripts/store.ts');
const { api } = await import('../src/api.js');

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('condition not met');
}

describe('乐观回显（pendingInput）', () => {
    it('创建请求还没返回，用户输入已经可见；真实 run 进入会话后清空', async () => {
        let release: (value: unknown) => void = () => {};
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        vi.mocked(api).mockImplementation(async (path: string) => {
            if (path === '/api/sessions') {
                await gate;
                return { sessionId: 's-new', conversationId: 'c1', state: 'active' };
            }
            if (path.includes('/timeline')) {
                return { rootGoalId: 's-new', goals: [], taskCount: 0, stepCount: 0 };
            }
            return [];
        });

        const running = createRun({ input: '帮我看下这个报错', exec: false });
        // 关键断言：POST /api/sessions 还挂着，输入已可渲染
        expect(pendingInput.value).toBe('帮我看下这个报错');

        release({});
        await running;
        expect(pendingInput.value).toBe('');
    });

    it('多个创建请求并发时，busy 保持到最后一个请求结束', async () => {
        const releases = new Map<string, () => void>();
        vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/api/sessions') {
                const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string };
                await new Promise<void>((resolve) => {
                    releases.set(body.input ?? '', resolve);
                });
                return {
                    sessionId: `s-${body.input}`,
                    conversationId: `c-${body.input}`,
                    state: 'active',
                };
            }
            if (path.includes('/timeline')) {
                return { rootGoalId: '', goals: [], taskCount: 0, stepCount: 0 };
            }
            return [];
        });

        const first = createRun({ input: 'first', exec: false });
        const second = createRun({ input: 'second', exec: false });
        expect(busy.value).toBe(true);

        releases.get('first')?.();
        await first;
        expect(busy.value).toBe(true);

        releases.get('second')?.();
        await second;
        expect(busy.value).toBe(false);
    });

    it('第二个 run 只进入执行队列，不切换当前 run 或订阅', async () => {
        const runResolvers = new Map<string, () => void>();
        vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/api/sessions') {
                const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string };
                const name = body.input ?? '';
                return {
                    sessionId: `s-${name}`,
                    conversationId: 'c-shared',
                    state: 'active',
                };
            }
            if (path.endsWith('/run')) {
                const name = path.includes('s-first') ? 'first' : 'second';
                await new Promise<void>((resolve) => {
                    runResolvers.set(name, resolve);
                });
                return { ok: true, tasks: [] };
            }
            if (path.includes('/timeline')) {
                return { rootGoalId: '', goals: [], taskCount: 0, stepCount: 0 };
            }
            return [];
        });

        const first = createRun({ input: 'first', exec: true });
        await waitFor(() => current.value === 's-first' && runResolvers.has('first'));

        const second = createRun({ input: 'second', exec: true });
        await waitFor(
            () =>
                executionQueue.value.length === 2 &&
                executionQueue.value[1]?.status === 'queued',
        );
        expect(current.value).toBe('s-first');
        expect(currentConversation.value).toBe('c-shared');

        runResolvers.get('first')?.();
        await waitFor(
            () =>
                current.value === 's-second' &&
                executionQueue.value[0]?.rootGoalId === 's-second',
        );

        runResolvers.get('second')?.();
        await Promise.all([first, second]);
        expect(executionQueue.value).toEqual([]);
    });
});
