import { describe, expect, it } from 'vitest';

import type { LLMMessage, ToolCall } from '@mazi/core';

import { ContextManager } from '../src/harness/context-manager.js';
import {
    attributeToolCallsToRoundDiff,
    measureContext,
} from '../src/harness/context-measure.js';

const user = (text: string): LLMMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
});
const assistant = (text: string, toolCalls: ToolCall[] = []): LLMMessage => ({
    role: 'assistant',
    content: text.length > 0 ? [{ type: 'text', text }] : [],
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
});
const tool = (callId: string, output: string): LLMMessage => ({
    role: 'tool',
    results: [{ callId, output }],
});

describe('measureContext diff semantics', () => {
    it('上一轮的 tool-call args 不计入下一轮 input diff（只保留 tool result）', () => {
        const messages: LLMMessage[] = [
            user('do the thing'),
            assistant('let me check', [
                { callId: 'c1', name: 'shell.run', arguments: { command: 'ls' } },
            ]),
            tool('c1', 'FILE-A'),
        ];
        // prevMessageCount = 1：user 在早前基线，后两条为本轮新增。
        const breakdown = measureContext(
            { messages, systemPrompt: 'SYS', tools: [] },
            undefined,
            1,
            128000,
        );

        expect(breakdown.diffContents?.toolCalls).toBe('');
        expect(breakdown.diffContent).not.toContain('[tool call]');
        // assistant 文本 / tool result 仍是本轮 input diff 的增量。
        expect(breakdown.diffContents?.historyAssistant).toContain('let me check');
        expect(breakdown.diffContents?.observation).toContain('FILE-A');
        // 全量原文与 token 计量不受影响（args 仍属于上下文）。
        expect(breakdown.contents?.toolCalls).toContain('shell.run');
        expect(breakdown.toolCallTokens).toBeGreaterThan(0);
    });

    it('attributeToolCallsToRoundDiff 把本轮 args 归到产出它的这一轮 diff', () => {
        const breakdown = measureContext(
            { messages: [user('hi')], systemPrompt: 'SYS', tools: [] },
            undefined,
            0,
            128000,
        );
        attributeToolCallsToRoundDiff(breakdown, [
            { callId: 'c2', toolName: 'fs.read', arguments: { path: 'a' } },
        ]);
        expect(breakdown.diffContents?.toolCalls).toContain('fs.read');
        expect(breakdown.diffContent).toContain('[tool call]');
    });

    it('ContextManager 跨轮：下一轮 diff 无 args，工具结果在；args 留在全量段', () => {
        const manager = new ContextManager({ systemPrompt: 'sys' });
        manager.appendUser('q');
        manager.measure(1000);
        manager.appendAssistant({
            text: 'thinking',
            toolCalls: [{ callId: 'c1', name: 't', arguments: { x: 1 } }],
        });
        manager.appendToolResults([{ callId: 'c1', output: 'RESULT' }]);

        const second = manager.measure(1000);
        expect(second.diffContents?.toolCalls).toBe('');
        expect(second.diffContents?.observation).toContain('RESULT');
        expect(second.contents?.toolCalls).toContain('"x":1');
        expect(second.toolCallTokens).toBeGreaterThan(0);
    });
});
