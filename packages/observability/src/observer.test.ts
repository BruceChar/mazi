import { describe, expect, it } from 'vitest';
import { compactContextText, observationPayloadFor } from './observer.js';

describe('Observer（结构化工具观察）', () => {
    it('成功结果保留头尾并标记截断', () => {
        const payload = observationPayloadFor({
            sessionId: 's',
            turnId: 't',
            toolName: 'fs.read',
            result: {
                ok: true,
                content: 'x'.repeat(10_000),
            },
        });
        expect(payload.content).toHaveLength(10_000);
        expect(payload.structured).toEqual({
            ok: true,
            toolName: 'fs.read',
            length: 10_000,
            truncated: true,
        });
        expect(payload.contextContent).toContain('已截断');
        expect(compactContextText('short', 4000)).toBe('short');
    });

    it('失败结果携带 isError 与 retryable', () => {
        const payload = observationPayloadFor({
            sessionId: 's',
            turnId: 't',
            toolName: 'fs.write',
            result: { ok: false, error: '权限不足', retryable: true },
        });
        expect(payload.isError).toBe(true);
        expect(payload.content).toBe('权限不足');
        expect(payload.structured).toEqual({
            ok: false,
            toolName: 'fs.write',
            retryable: true,
        });
    });
});
