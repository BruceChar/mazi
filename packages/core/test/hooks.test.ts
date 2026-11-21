import { describe, expect, it } from 'vitest';
import {
    HOOK_DEFAULT_MODE,
    HOOK_POINTS,
    isHookPoint,
    sessionStreamId,
} from '../src/index.js';

describe('hook 契约（docs/runtime/AHF_RUNTIME_KERNEL_AND_HOOKS.md §4）', () => {
    it('钩子点是闭集，且每个点都有默认派发语义', () => {
        expect(HOOK_POINTS).toHaveLength(10);
        for (const point of HOOK_POINTS) {
            expect(HOOK_DEFAULT_MODE[point]).toBeTruthy();
        }
        expect(HOOK_DEFAULT_MODE['tool.pre']).toBe('bail');
        expect(HOOK_DEFAULT_MODE['turn.start']).toBe('waterfall');
        expect(HOOK_DEFAULT_MODE['turn.end']).toBe('parallel');
        expect(HOOK_DEFAULT_MODE['llm.pre']).toBe('emit');
    });

    it('isHookPoint 只接受闭集内的点', () => {
        expect(isHookPoint('tool.pre')).toBe(true);
        expect(isHookPoint('session.start')).toBe(true);
        expect(isHookPoint('tool.maybe')).toBe(false);
        expect(isHookPoint('')).toBe(false);
    });

    it('会话事件流锚点稳定且与 ULID 不冲突', () => {
        const sessionId = '01JABCDEFGHJKLMNPQRSTUVWXY';
        expect(sessionStreamId(sessionId)).toBe(`session-${sessionId}`);
        // 锚点必须是非空字符串，满足事件信封 rootGoalId 的必填约束。
        expect(sessionStreamId(sessionId).length).toBeGreaterThan(0);
    });
});
