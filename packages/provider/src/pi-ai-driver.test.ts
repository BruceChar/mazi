import type { Model, Models } from '@earendil-works/pi-ai';
import {
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxThinking,
    fauxToolCall,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { LLMStreamEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { DefaultDriverRegistry } from './default-registry.js';
import { PiAiDriver } from './pi-ai-driver.js';
import { normalizeProvider } from './registry.js';

function toolSpec() {
    return {
        name: 'fs.read',
        description: '读文件',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
        minPermission: 'read-only' as const,
        sideEffects: ['fs'] as const,
    };
}

async function collect(driver: PiAiDriver, msg: string): Promise<LLMStreamEvent[]> {
    const out: LLMStreamEvent[] = [];
    for await (const e of driver.stream({
        model: { providerId: 'faux', vendor: 'faux', modelId: 'faux-model' },
        context: {
            systemPrompt: 'sys',
            messages: [{ role: 'user', content: msg }],
            tools: [toolSpec()],
        },
    })) {
        out.push(e);
    }
    return out;
}

describe('PiAiDriver（@earendil-works/pi-ai，faux provider 离线验证）', () => {
    it('stream：文本轮次翻译为 text-delta → end（含 usage）', async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([fauxAssistantMessage('你好，任务完成。')]);
        const driver = new PiAiDriver(
            { type: 'pi-ai', provider: faux.provider.id, model: faux.getModel().id },
            { models },
        );
        const events = await collect(driver, '你好');
        const text = events
            .filter((e): e is { type: 'text-delta'; delta: string } => e.type === 'text-delta')
            .map((e) => e.delta)
            .join('');
        expect(text).toContain('任务完成');
        expect(events.some((e) => e.type === 'end')).toBe(true);
        expect(events.some((e) => e.type === 'usage')).toBe(true);
        const usageEvent = events.find((e) => e.type === 'usage');
        expect(
            (usageEvent as { usage: { reportedByVendor: boolean } } | undefined)?.usage
                .reportedByVendor,
        ).toBe(true);
    });

    it('stream：thinking + toolCall 轮次翻译为 reasoning-delta / tool-call', async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([
            fauxAssistantMessage(
                [fauxThinking('先分析'), fauxToolCall('fs.read', { path: '/tmp/x' }, { id: 'c1' })],
                { stopReason: 'toolUse' },
            ),
        ]);
        const driver = new PiAiDriver(
            { type: 'pi-ai', provider: faux.provider.id, model: faux.getModel().id },
            { models },
        );
        const events = await collect(driver, '读文件');
        const toolCalls = events.filter(
            (e): e is { type: 'tool-call'; toolName: string; callId: string } =>
                e.type === 'tool-call',
        );
        expect(toolCalls.length).toBe(1);
        expect(toolCalls[0]).toMatchObject({ toolName: 'fs.read', callId: 'c1' });
        const end = events.find((e) => e.type === 'end') as { finishReason?: string } | undefined;
        expect(end?.finishReason).toBe('tool_calls');
    });

    it('complete：聚合最终文本与 usage', async () => {
        const faux = fauxProvider();
        const models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([fauxAssistantMessage('最终答复。')]);
        const driver = new PiAiDriver(
            { type: 'pi-ai', provider: faux.provider.id, model: faux.getModel().id },
            { models },
        );
        const res = await driver.complete({
            model: { providerId: 'faux', vendor: 'faux', modelId: 'faux-model' },
            context: { systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] },
        });
        expect(res.content).toContain('最终答复');
        expect(res.finishReason).toBe('stop');
        expect(res.usage?.reportedByVendor).toBe(true);
    });

    it('PA-A3：apiKeyEnv 配置但缺失 → 首次调用抛错，且不触碰模型流', async () => {
        let streamCalled = false;
        const fakeModel = { id: 'm', provider: 'x' } as unknown as Model<never>;
        const fakeModels = {
            getModel: () => fakeModel,
            stream: () => {
                streamCalled = true;
                return (async function* () {})();
            },
            complete: async () => {
                streamCalled = true;
                return undefined;
            },
        } as unknown as Models;
        const driver = new PiAiDriver(
            { type: 'pi-ai', provider: 'x', model: 'm', apiKeyEnv: 'PI_TEST_MISSING_KEY' },
            { models: fakeModels },
        );
        await expect(collect(driver, 'hi')).rejects.toThrow('PI_TEST_MISSING_KEY');
        expect(streamCalled).toBe(false);
    });
});

describe('PiAiDriver 默认 env 读取（openai→OPENAI_API_KEY / deepseek→DEEPSEEK_API_KEY）', () => {
    function envStubModels(captured: { options?: unknown }[]) {
        const fakeModel = { id: 'm', provider: 'x' } as unknown as Model<never>;
        return {
            getModel: () => fakeModel,
            stream: (_model: unknown, _ctx: unknown, options?: unknown) => {
                captured.push({ options });
                return (async function* () {})();
            },
            complete: async () => {
                captured.push({ options: undefined });
                return undefined;
            },
        } as unknown as Models;
    }
    async function invokeStream(driver: PiAiDriver): Promise<void> {
        for await (const _e of driver.stream({
            model: { providerId: 'x', vendor: 'x', modelId: 'm' },
            context: { messages: [{ role: 'user', content: 'hi' }], tools: [] },
        })) {
            // 消费空流
        }
    }

    it('provider=openai 未显式 apiKeyEnv 时读取 OPENAI_API_KEY 并透传 apiKey', async () => {
        process.env.OPENAI_API_KEY = 'sk-openai-test';
        try {
            const captured: { options?: unknown }[] = [];
            const driver = new PiAiDriver(
                { type: 'pi-ai', provider: 'openai', model: 'gpt-4o-mini' },
                { models: envStubModels(captured) },
            );
            await invokeStream(driver);
            expect(captured[0]).toEqual({ options: { apiKey: 'sk-openai-test' } });
        } finally {
            delete process.env.OPENAI_API_KEY;
        }
    });

    it('provider=deepseek 未显式 apiKeyEnv 时读取 DEEPSEEK_API_KEY', async () => {
        process.env.DEEPSEEK_API_KEY = 'sk-deepseek-test';
        try {
            const captured: { options?: unknown }[] = [];
            const driver = new PiAiDriver(
                { type: 'pi-ai', provider: 'deepseek', model: 'deepseek-chat' },
                { models: envStubModels(captured) },
            );
            await invokeStream(driver);
            expect(captured[0]).toEqual({ options: { apiKey: 'sk-deepseek-test' } });
        } finally {
            delete process.env.DEEPSEEK_API_KEY;
        }
    });

    it('默认 env 缺失（openai 无 OPENAI_API_KEY）→ 抛清晰错误且不触碰模型流', async () => {
        delete process.env.OPENAI_API_KEY;
        const captured: { options?: unknown }[] = [];
        const driver = new PiAiDriver(
            { type: 'pi-ai', provider: 'openai', model: 'gpt-4o-mini' },
            { models: envStubModels(captured) },
        );
        await expect(invokeStream(driver)).rejects.toThrow(/OPENAI_API_KEY/);
        expect(captured).toHaveLength(0);
    });

    it('未命中默认映射（faux/无鉴权）→ 不校验 env 直接透传', async () => {
        const captured: { options?: unknown }[] = [];
        const driver = new PiAiDriver(
            { type: 'pi-ai', provider: 'faux', model: 'faux-model' },
            { models: envStubModels(captured) },
        );
        await invokeStream(driver);
        expect(captured[0]).toEqual({ options: undefined });
    });
});

describe('DefaultDriverRegistry（PA-A4）', () => {
    it('type=pi-ai → PiAiDriver；未知或缺失 type 抛错', () => {
        const reg = new DefaultDriverRegistry();
        const provider = normalizeProvider({
            id: 'p',
            vendor: 'v',
            models: [
                {
                    id: 'm',
                    contextWindow: 1000,
                    supportsTools: true,
                    supportsThinking: false,
                    supportsVision: false,
                },
            ],
        });
        const piDriver = reg.build(provider, {
            id: 'p',
            vendor: 'v',
            models: provider.models,
            driver: { type: 'pi-ai', model: 'gpt-4o-mini' },
        });
        expect(piDriver).toBeInstanceOf(PiAiDriver);
        expect(() =>
            reg.build(provider, {
                id: 'p',
                vendor: 'v',
                models: provider.models,
                driver: { type: 'nope' as never },
            }),
        ).toThrow(/未知或缺失 driver.type/);
        expect(() =>
            reg.build(provider, {
                id: 'p',
                vendor: 'v',
                models: provider.models,
                driver: {},
            }),
        ).toThrow(/缺失 driver.type/);
    });
});

describe('真实 DeepSeek 目录模型（回归：deepseek-chat 退役导致会话全失败）', () => {
    it('v4 目录可解析 deepseek-v4-flash / vision / pro，且不含已退役 deepseek-chat', () => {
        const models = builtinModels();
        const ids = models.getModels('deepseek').map((m) => m.id);
        expect(ids).toContain('deepseek-v4-flash');
        expect(ids).toContain('deepseek-v4-flash-vision-exp');
        expect(ids).toContain('deepseek-v4-pro');
        expect(ids).not.toContain('deepseek-chat');
        expect(ids).not.toContain('deepseek-reasoner');
        for (const id of ids.filter((x) => x.startsWith('deepseek-v4'))) {
            expect(models.getModel('deepseek', id)).toBeDefined();
        }
    });
});
