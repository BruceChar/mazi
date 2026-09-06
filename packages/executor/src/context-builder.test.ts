import type { Step } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { buildContext, buildContextMessages } from './context-builder.js';

function step(over: Partial<Step>): Step {
    return {
        stepId: 's',
        turnId: 't',
        sessionId: 'sess',
        seq: 0,
        kind: 'thinking',
        payload: { content: '' },
        status: 'ok',
        startedAt: 0,
        ...over,
    } as Step;
}

describe('buildContextMessages（工具轮历史重建）', () => {
    it('tool 结果沿用同一 tool_call 的 callId（真实厂商要求 tool 紧随 assistant tool_calls）', () => {
        const messages = buildContextMessages([
            step({
                seq: 0,
                kind: 'tool_call',
                payload: {
                    toolName: 'fs.read',
                    arguments: { path: '.' },
                    callId: 'call_00_real',
                },
            }),
            step({
                seq: 1,
                kind: 'observation',
                payload: { toolName: 'fs.read', content: 'OK', isError: false },
            }),
        ]);
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({
            role: 'assistant',
            toolCallId: 'call_00_real',
            name: 'fs.read',
            arguments: { path: '.' },
        });
        expect(messages[1]).toMatchObject({
            role: 'tool',
            toolCallId: 'call_00_real',
            name: 'fs.read',
        });
    });

    it('buildContext 把用户原始输入注入 messages 首条（LLM 必须真实看到输入）', () => {
        const built = buildContext({
            systemPrompt: 'sys',
            steps: [
                step({
                    seq: 0,
                    kind: 'thinking',
                    payload: { content: '我在思考' },
                }),
            ],
            newInput: 'how to think',
            tools: [],
        });
        expect(built.context.messages[0]).toEqual({
            role: 'user',
            content: 'how to think',
        });
        expect(built.context.messages[1]).toMatchObject({
            role: 'assistant',
            content: '我在思考',
        });
    });
});
