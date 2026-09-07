import { describe, expect, it } from 'vitest';
import { collectLLMRound } from './round.js';

describe('collectLLMRound（Provider → Observer 归一契约）', () => {
    it('文本/推理/工具/usage/end 聚合成完整轮次并计时', () => {
        const now = (() => {
            let t = 1_000;
            return () => {
                t += 100;
                return t;
            };
        })();
        const round = collectLLMRound(
            [
                { type: 'text-delta', delta: '你好' },
                { type: 'text-delta', delta: '，世界' },
                { type: 'reasoning-delta', delta: '先分析' },
                {
                    type: 'tool-call',
                    callId: 'c1',
                    toolName: 'fs.read',
                    arguments: { path: '/tmp/a' },
                },
                {
                    type: 'usage',
                    usage: { inputTokens: 10, outputTokens: 5, reportedByVendor: false },
                },
                { type: 'end', finishReason: 'tool_use' },
            ],
            900,
            now,
        );
        expect(round.text).toBe('你好，世界');
        expect(round.reasoning).toBe('先分析');
        expect(round.toolCalls).toEqual([
            { type: 'tool-call', callId: 'c1', toolName: 'fs.read', arguments: { path: '/tmp/a' } },
        ]);
        expect(round.vendorUsage).toEqual({
            inputTokens: 10,
            outputTokens: 5,
            reportedByVendor: false,
        });
        expect(round.finishReason).toBe('tool_use');
        expect(round.ttftMs).toBe(200);
        expect(round.totalMs).toBe(300);
    });

    it('仅推理无文本时文本为空且 ttft 为 0', () => {
        const round = collectLLMRound([{ type: 'reasoning-delta', delta: '思考中' }], 0, () => 500);
        expect(round.text).toBe('');
        expect(round.reasoning).toBe('思考中');
        expect(round.ttftMs).toBe(0);
        expect(round.totalMs).toBe(500);
    });
});
