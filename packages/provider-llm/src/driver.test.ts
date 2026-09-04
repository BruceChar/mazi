import type { LLMRequest, LLMStreamEvent, VendorUsage } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from './driver';

const req: LLMRequest = {
    model: { providerId: 'scripted', vendor: 'scripted', modelId: 'm' },
    context: { messages: [], tools: [] },
};

async function collect(iterable: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
    const events: LLMStreamEvent[] = [];
    for await (const event of iterable) {
        events.push(event);
    }
    return events;
}

describe('ScriptedDriver（MVP v1.0 §8 F5 / D3）', () => {
    it('round 事件顺序固定：reasoning/text/tool-call/usage/end，usage 透传', async () => {
        const usage: VendorUsage = {
            inputTokens: 120,
            outputTokens: 45,
            cacheReadInputTokens: 60,
            reasoningOutputTokens: 30,
            reportedByVendor: true,
        };
        const driver = new ScriptedDriver({
            rounds: [
                {
                    reasoning: '先规划',
                    text: '需要读文件',
                    toolCalls: [
                        { callId: 'call-1', toolName: 'fs.read', arguments: { path: 'a.txt' } },
                        { callId: 'call-2', toolName: 'fs.read', arguments: { path: 'b.txt' } },
                    ],
                    usage,
                    finishReason: 'tool_calls',
                },
            ],
        });
        const events = await collect(driver.stream(req));
        expect(events).toEqual([
            { type: 'reasoning-delta', delta: '先规划' },
            { type: 'text-delta', delta: '需要读文件' },
            {
                type: 'tool-call',
                callId: 'call-1',
                toolName: 'fs.read',
                arguments: { path: 'a.txt' },
            },
            {
                type: 'tool-call',
                callId: 'call-2',
                toolName: 'fs.read',
                arguments: { path: 'b.txt' },
            },
            { type: 'usage', usage },
            { type: 'end', finishReason: 'tool_calls' },
        ]);
    });

    it('usage/finishReason 缺省：全零 usage + reportedByVendor=false，end=stop', async () => {
        const driver = new ScriptedDriver({ rounds: [{ text: '你好' }] });
        const events = await collect(driver.stream(req));
        expect(events).toEqual([
            { type: 'text-delta', delta: '你好' },
            { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, reportedByVendor: false } },
            { type: 'end', finishReason: 'stop' },
        ]);
    });

    it('failCalls>0：前 N 次 stream() 同步抛 scripted-fail，失败不消费 round', async () => {
        const driver = new ScriptedDriver({
            rounds: [{ text: 'A' }, { text: 'B' }],
            failCalls: 2,
        });
        expect(() => driver.stream(req)).toThrow('scripted-fail');
        expect(() => driver.stream(req)).toThrow('scripted-fail');
        expect(await collect(driver.stream(req))).toContainEqual({
            type: 'text-delta',
            delta: 'A',
        });
        expect(await collect(driver.stream(req))).toContainEqual({
            type: 'text-delta',
            delta: 'B',
        });
    });

    it('round 用尽后重复最后一个 round', async () => {
        const driver = new ScriptedDriver({ rounds: [{ text: 'A' }, { text: 'B' }] });
        const nextTexts = async (): Promise<string[]> => {
            const events = await collect(driver.stream(req));
            return events
                .filter((event) => event.type === 'text-delta')
                .map((event) => event.delta);
        };
        expect(await nextTexts()).toEqual(['A']);
        expect(await nextTexts()).toEqual(['B']);
        expect(await nextTexts()).toEqual(['B']);
        expect(await nextTexts()).toEqual(['B']);
    });

    it('complete() 拼接已消费 round 的 text，不消费新 round、不受 failCalls 影响', async () => {
        const driver = new ScriptedDriver({
            rounds: [{ text: 'A' }, { text: 'B' }],
            failCalls: 1,
        });
        expect((await driver.complete(req)).content).toBe('');
        expect(() => driver.stream(req)).toThrow('scripted-fail');
        expect((await driver.complete(req)).content).toBe('');
        await collect(driver.stream(req));
        expect((await driver.complete(req)).content).toBe('A');
        await collect(driver.stream(req));
        const response = await driver.complete(req);
        expect(response.content).toBe('AB');
        expect(response.usage).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            reportedByVendor: false,
        });
    });

    it('complete() 汇总已消费轮的 usage（未声明轮按 0 计）', async () => {
        const driver = new ScriptedDriver({
            rounds: [
                { text: 'x', usage: { inputTokens: 10, outputTokens: 20, reportedByVendor: true } },
                { text: 'y' },
            ],
        });
        await collect(driver.stream(req));
        const afterFirst = await driver.complete(req);
        expect(afterFirst.usage).toEqual({
            inputTokens: 10,
            outputTokens: 20,
            reportedByVendor: true,
        });
        await collect(driver.stream(req));
        const afterSecond = await driver.complete(req);
        // 第二轮未声明 usage：整体回退为估算口径
        expect(afterSecond.usage).toEqual({
            inputTokens: 10,
            outputTokens: 20,
            reportedByVendor: false,
        });
    });

    it('rounds 为空：构造即抛错（配置错误尽早暴露）', () => {
        expect(() => new ScriptedDriver({ rounds: [] })).toThrow(/rounds/);
    });
});
