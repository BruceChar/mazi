import { describe, expect, it } from 'vitest';
import { createRuntimeContext } from '../src/harness/runtime-context.js';

describe('createRuntimeContext', () => {
    it('返回 8 个互不共享的平面壳，装配期逐项填入', () => {
        const ctx = createRuntimeContext();
        expect(Object.keys(ctx).sort()).toEqual([
            'analysis',
            'assembly',
            'delegation',
            'intelligence',
            'memory',
            'observability',
            'session',
            'tools',
        ]);
        expect(ctx.observability).not.toBe(ctx.assembly);
        expect(Object.keys(ctx.observability)).toEqual([]);
    });
});
