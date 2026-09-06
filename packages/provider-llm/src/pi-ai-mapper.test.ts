import type { Usage } from '@earendil-works/pi-ai';
import type { ToolSpec } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import {
    buildPiContext,
    mapFinishReason,
    messagesToPi,
    restoreSanitizedToolName,
    toolsToPi,
    toVendorUsage,
    translatePiEvent,
} from './pi-ai-mapper.js';

const meta = { api: 'openai-completions', provider: 'openai', model: 'gpt-4o-mini' };

function usage(): Usage {
    return {
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 10,
        reasoning: 8,
        totalTokens: 188,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
}

describe('pi-ai mapper（离线，ProviderAdapter 设计 PA-A2）', () => {
    it('messagesToPi：user/assistant/tool 映射；assistant 工具意图跳过；system 过滤', () => {
        const msgs = [
            { role: 'system' as const, content: '你是助手' },
            { role: 'user' as const, content: '你好' },
            { role: 'assistant' as const, content: '在思考' },
            { role: 'assistant' as const, content: '', name: 'fs.read', toolCallId: 'c1' },
            { role: 'tool' as const, content: '内容', name: 'fs.read', toolCallId: 'c1' },
            { role: 'tool' as const, content: '[error] 失败', name: 'fs.read', toolCallId: 'c2' },
        ];
        const out = messagesToPi(msgs, meta, () => 123);
        expect(out).toHaveLength(4);
        expect(out[0]).toMatchObject({ role: 'user', content: '你好', timestamp: 123 });
        expect(out[1]).toMatchObject({
            role: 'assistant',
            provider: 'openai',
            model: 'gpt-4o-mini',
        });
        const toolResults = out.filter((m) => m.role === 'toolResult') as {
            role: 'toolResult';
            toolName: string;
            isError: boolean;
            content: { text: string }[];
        }[];
        expect(toolResults[0]).toMatchObject({
            toolName: 'fs_read',
            toolCallId: 'c1',
            isError: false,
        });
        expect(toolResults[0]?.content[0]?.text).toBe('内容');
        expect(toolResults[1]?.isError).toBe(true);
        expect(toolResults[1]?.content[0]?.text).toBe('失败');
    });

    it('buildPiContext：提取 systemPrompt、tools 转换', () => {
        const spec: ToolSpec = {
            name: 'fs.read',
            description: '读文件',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
            },
            minPermission: 'read-only',
            sideEffects: ['fs'],
        };
        const ctx = buildPiContext({
            systemPrompt: 'system-x',
            messages: [{ role: 'system', content: 'should-not-matter' }],
            tools: [spec],
            meta,
        });
        expect(ctx.systemPrompt).toBe('system-x');
        expect(ctx.messages).toEqual([]);
        expect(ctx.tools).toHaveLength(1);
        // 真实厂商（OpenAI/DeepSeek）要求 function.name 匹配 ^[a-zA-Z0-9_-]+$
        expect(ctx.tools?.[0]?.name).toBe('fs_read');
    });

    it('toolsToPi：参数按 TSchema 透传', () => {
        const spec: ToolSpec = {
            name: 'a',
            description: 'd',
            parameters: { type: 'object', properties: {} },
            minPermission: 'read-only',
            sideEffects: ['fs'],
        };
        const tools = toolsToPi([spec]);
        expect(tools[0]).toMatchObject({ name: 'a', description: 'd' });
        const first = tools[0] as { parameters: { type: string } };
        expect(first.parameters.type).toBe('object');
    });

    it('工具名清洗：含点/空格的名字发给厂商前替换为合法字符，并能还原原始名', () => {
        const spec: ToolSpec = {
            name: 'fs.read',
            description: '读文件',
            parameters: { type: 'object', properties: {} },
            minPermission: 'read-only',
            sideEffects: ['fs'],
        };
        const pi = toolsToPi([spec]);
        expect(pi[0]?.name).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(pi[0]?.name).toBe('fs_read');
        expect(restoreSanitizedToolName('fs_read', [spec])).toBe('fs.read');
    });

    it('toVendorUsage：input/output/cache/reasoning 全映射，reportedByVendor=true', () => {
        const v = toVendorUsage(usage());
        expect(v).toEqual({
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            reasoningOutputTokens: 8,
            reportedByVendor: true,
        });
    });

    it('mapFinishReason 对照表', () => {
        expect(mapFinishReason('stop')).toBe('stop');
        expect(mapFinishReason('toolUse')).toBe('tool_calls');
        expect(mapFinishReason('length')).toBe('length');
        expect(mapFinishReason('error')).toBe('error');
    });

    it('translatePiEvent：text/thinking/toolcall/done/error', () => {
        expect(
            translatePiEvent({
                type: 'text_delta',
                contentIndex: 0,
                delta: 'hi',
                partial: {} as never,
            }),
        ).toEqual([{ type: 'text-delta', delta: 'hi' }]);
        expect(
            translatePiEvent({
                type: 'thinking_delta',
                contentIndex: 0,
                delta: '再想想',
                partial: {} as never,
            }),
        ).toEqual([{ type: 'reasoning-delta', delta: '再想想' }]);
        const tc = translatePiEvent({
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall: { type: 'toolCall', id: 'c', name: 'fs.read', arguments: { path: '/x' } },
            partial: {} as never,
        });
        expect(tc).toEqual([
            { type: 'tool-call', callId: 'c', toolName: 'fs.read', arguments: { path: '/x' } },
        ]);
        const done = translatePiEvent({
            type: 'done',
            reason: 'toolUse',
            message: {
                role: 'assistant',
                content: [],
                api: 'openai-completions',
                provider: 'openai',
                model: 'm',
                usage: usage(),
                stopReason: 'toolUse',
                timestamp: 1,
            },
        });
        expect(done[0]).toMatchObject({ type: 'usage' });
        expect(done[1]).toMatchObject({ type: 'end', finishReason: 'tool_calls' });
        expect(() =>
            translatePiEvent({
                type: 'error',
                reason: 'error',
                error: {
                    role: 'assistant',
                    content: [],
                    api: 'openai-completions',
                    provider: 'openai',
                    model: 'm',
                    usage: usage(),
                    stopReason: 'error',
                    timestamp: 1,
                    errorMessage: 'boom',
                },
            }),
        ).toThrow('boom');
        expect(translatePiEvent({ type: 'start', partial: {} as never })).toEqual([]);
    });
});
