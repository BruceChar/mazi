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

const { busy, createRun, pendingInput } = await import('../src/scripts/store.ts');
const { api } = await import('../src/api.js');

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
});
