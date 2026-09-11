import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxThinking,
    fauxToolCall,
} from '@earendil-works/pi-ai';
import type { LLMMessage, LLMRequest, StreamCompletionEvent, ToolSchema } from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { createProviderClient } from './client.js';
import { createPiProvider, normalizePiUsage } from './pi-ai-adapter.js';

function userMsg(text: string): LLMMessage {
    return { role: 'user', content: [{ type: 'text', text }], createdAt: 0 };
}

function sysMsg(text: string): LLMMessage {
    return { role: 'system', content: [{ type: 'text', text }], createdAt: 0 };
}

function req(messages: LLMMessage[], extra?: Partial<Omit<LLMRequest, 'messages'>>): LLMRequest {
    return { messages, ...extra };
}

/** 组装：faux provider → Models → bridge（离线，无网络）。 */
function setupBridge(responses: unknown[]) {
    const faux = fauxProvider({
        provider: 'faux',
        models: [{ id: 'faux-model', input: ['text'] }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(responses as never);
    const bridge = createPiProvider({ models, providerId: 'faux', defaultModel: 'faux-model' });
    return { bridge, faux };
}

async function collect(
    stream: AsyncIterable<StreamCompletionEvent>,
): Promise<StreamCompletionEvent[]> {
    const chunks: StreamCompletionEvent[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}

describe('pi-ai adapter（新契约：ask/askStream 双入口）', () => {
    it('ask：文本与模型元信息映射', async () => {
        const { bridge } = setupBridge([fauxAssistantMessage('hello')]);
        const res = await bridge.ask(req([userMsg('hi')]));
        expect(res.content.map((b) => (b.type === 'text' ? b.text : ''))).toEqual(['hello']);
        expect(res.finishReason).toBe('stop');
        expect(res.model).toBe('faux-model');
        expect(bridge.models[0]?.id).toBe('faux-model');
    });

    it('ask：工具调用映射（toolUse → tool_calls）', async () => {
        const { bridge } = setupBridge([
            fauxAssistantMessage(fauxToolCall('get_time', { tz: 'UTC' }), {
                stopReason: 'toolUse',
            }),
        ]);
        const res = await bridge.ask(req([userMsg('time?')]));
        expect(res.finishReason).toBe('tool_calls');
        expect(res.toolCalls?.[0]?.name).toBe('get_time');
        expect(res.toolCalls?.[0]?.arguments).toEqual({ tz: 'UTC' });
    });

    it('askStream：thinking_delta → reasoning_delta、text_delta → text_delta', async () => {
        const { bridge } = setupBridge([
            fauxAssistantMessage([fauxThinking('先思考'), fauxText('再回答')]),
        ]);
        const chunks = await collect(bridge.askStream(req([userMsg('q')])));
        expect(chunks.some((c) => c.type === 'reasoning_delta' && c.reasoning === '先思考')).toBe(
            true,
        );
        expect(chunks.some((c) => c.type === 'text_delta' && c.text === '再回答')).toBe(true);
        expect(chunks.some((c) => c.type === 'finish' && c.finishReason === 'stop')).toBe(true);
    });

    it('askStream：tool_call_start/delta/stop 事件序列与参数拼接', async () => {
        const toolCall = fauxToolCall('get_time', { tz: 'UTC' });
        const { bridge } = setupBridge([fauxAssistantMessage(toolCall, { stopReason: 'toolUse' })]);
        const chunks = await collect(bridge.askStream(req([userMsg('time?')])));
        const deltas = chunks.filter((c) => c.type === 'tool_call_delta');
        expect(deltas.length).toBeGreaterThan(0);
        const argsJson = deltas.map((d) => d.argumentsDelta ?? '').join('');
        expect(JSON.parse(argsJson)).toEqual({ tz: 'UTC' });
        const starts = chunks.filter((c) => c.type === 'tool_call_start');
        expect(starts).toHaveLength(1);
        if (starts[0]?.type === 'tool_call_start') {
            expect(starts[0].callId).toBe(toolCall.id);
            expect(starts[0].name).toBe('get_time');
        }
        expect(chunks.some((c) => c.type === 'tool_call_stop')).toBe(true);
        expect(chunks.some((c) => c.type === 'finish' && c.finishReason === 'tool_calls')).toBe(
            true,
        );
    });

    it('上下文转换：system → systemPrompt、user 消息顺序保留、tools 传递', async () => {
        const { bridge } = setupBridge([
            (context: { systemPrompt?: string; messages: { role: string }[]; tools?: unknown[] }) =>
                fauxAssistantMessage(
                    `sys:${context.systemPrompt ?? ''}|roles:${context.messages.map((m) => m.role).join(',')}|tools:${(context.tools ?? []).length}`,
                ),
        ]);
        const tools: ToolSchema[] = [
            {
                name: 'bash',
                description: '执行命令',
                parameters: {
                    type: 'object',
                    properties: { command: { type: 'string' } },
                    required: ['command'],
                },
            },
        ];
        const res = await bridge.ask(
            req([sysMsg('你是助手'), userMsg('你好'), userMsg('再见')], { tools }),
        );
        const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        expect(text.includes('sys:你是助手'), `systemPrompt: ${text}`).toBe(true);
        expect(text.includes('roles:user,user'), `roles: ${text}`).toBe(true);
        expect(text.includes('tools:1'), `tools: ${text}`).toBe(true);
    });

    it('错误映射：error → ProviderError 异常（rate_limit），ask 与 askStream 一致', async () => {
        const errorResponse = () => [
            fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'rate limit exceeded' }),
        ];
        const isRateLimit = (error: unknown): boolean =>
            error instanceof ProviderError && error.code === 'rate_limit';
        const { bridge: askBridge } = setupBridge(errorResponse());
        await expect(askBridge.ask(req([userMsg('x')]))).rejects.toSatisfy(isRateLimit);
        const { bridge: streamBridge } = setupBridge(errorResponse());
        await expect(collect(streamBridge.askStream(req([userMsg('x')])))).rejects.toSatisfy(
            isRateLimit,
        );
    });

    it('工具名安全化：canonical(fs.read) → wire(fs_read) 传给厂商（DeepSeek 命名规则）', async () => {
        let wireName = '';
        const { bridge } = setupBridge([
            (context: { tools?: unknown[] }) => {
                wireName = String(
                    (context.tools?.[0] as { name?: string } | undefined)?.name ?? '',
                );
                return fauxAssistantMessage('done');
            },
        ]);
        await bridge.ask(
            req([userMsg('读文件')], {
                tools: [
                    {
                        name: 'fs.read',
                        description: '读文件',
                        parameters: { type: 'object' },
                    },
                ],
            }),
        );
        expect(wireName).toBe('fs_read');
    });

    it('工具名回映：厂商返回 wire(fs_read) → canonical(fs.read)', async () => {
        const { bridge } = setupBridge([
            fauxAssistantMessage(fauxToolCall('fs_read', { path: 'a' }), { stopReason: 'toolUse' }),
        ]);
        const res = await bridge.ask(
            req([userMsg('读文件')], {
                tools: [
                    {
                        name: 'fs.read',
                        description: '读文件',
                        parameters: { type: 'object' },
                    },
                ],
            }),
        );
        expect(res.toolCalls?.[0]?.name).toBe('fs.read');
    });

    it('usage 归一：input = miss + cacheRead + cacheWrite（全量口径），缓存为子集，reasoning ⊆ output', () => {
        const usage = normalizePiUsage({
            input: 100,
            output: 50,
            cacheRead: 40,
            cacheWrite: 10,
            reasoning: 20,
        });
        // pi-ai 的 input 是未命中缓存部分；core 要求 inputTokens 为全部输入
        expect(usage.inputTokens).toBe(150);
        expect(usage.outputTokens).toBe(50);
        expect(usage.totalTokens).toBe(200);
        expect(usage.cachedInputTokens).toBe(40);
        expect(usage.cachedWriteInputTokens).toBe(10);
        expect(usage.reasoningTokens).toBe(20);
        // reasoning 是 output 子集：output 已含 reasoning，不重复加
        expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens);
    });

    it('usage 归一：无缓存/未报告 reasoning 时不置 0（避免伪造细分）', () => {
        const usage = normalizePiUsage({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });
        expect(usage.inputTokens).toBe(5);
        expect(usage.totalTokens).toBe(11);
        expect(usage).not.toHaveProperty('cachedInputTokens');
        expect(usage).not.toHaveProperty('cachedWriteInputTokens');
        expect(usage).not.toHaveProperty('reasoningTokens');
    });

    it('client 包装：事件与 stats 在失败路径上工作', async () => {
        const { bridge } = setupBridge([
            fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'rate limit exceeded' }),
        ]);
        const events: string[] = [];
        const client = createProviderClient({
            provider: bridge,
            maxRetries: 0,
            onEvent: (e) => events.push(e.type),
        });
        await expect(client.ask(req([userMsg('x')]))).rejects.toBeInstanceOf(ProviderError);
        expect(events).toContain('request');
        expect(events).toContain('error');
        expect(client.stats.requestCount).toBe(1);
        expect(client.stats.errorCount).toBe(1);
    });
});
