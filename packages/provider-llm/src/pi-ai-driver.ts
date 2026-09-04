import type { Api, AssistantMessageEvent, Model, Models } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { LLMDriver, LLMRequest, LLMResponse, LLMStreamEvent } from '@mazi/core';
import type { PiModelMeta } from './pi-ai-mapper.js';
import {
    buildPiContext,
    mapFinishReason,
    toVendorUsage,
    translatePiEvent,
} from './pi-ai-mapper.js';

/** pi-ai provider → 默认 API key 环境变量（交互式配置向导与缺省运行均按此读取） */
export const DEFAULT_API_KEY_ENV: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    groq: 'GROQ_API_KEY',
    xai: 'XAI_API_KEY',
};

/** pi-ai 真实厂商 Driver 配置（对应 ProviderJson.driver） */
export interface PiAiDriverConfig {
    type: 'pi-ai';
    /** pi-ai provider id，默认 'openai' */
    provider?: string;
    /** 厂商模型名（须在 pi-ai 目录中） */
    model: string;
    /** 自定义 API key 环境变量名；配置但缺失 → 首次调用抛错 */
    apiKeyEnv?: string;
}

export interface PiAiDriverDeps {
    /** Models 集合：默认 builtinModels()；测试可注入 faux provider 集合 */
    models?: Models;
    now?: () => number;
}

/**
 * 真实厂商 Driver（feature：provider-adapter，设计文档 docs/ProviderAdapter设计.md）。
 * 经 core LLMDriver 防腐层注入，上层零改动；惰性解析模型、env 凭据校验。
 */
export class PiAiDriver implements LLMDriver {
    private readonly provider: string;
    private readonly modelId: string;
    private readonly apiKeyEnv?: string;
    private readonly models: Models;
    private readonly now: () => number;
    private modelHandle?: Model<Api>;

    constructor(config: PiAiDriverConfig, deps: PiAiDriverDeps = {}) {
        this.provider = config.provider ?? 'openai';
        this.modelId = config.model;
        this.apiKeyEnv = config.apiKeyEnv;
        this.models = deps.models ?? builtinModels();
        this.now = deps.now ?? Date.now;
    }

    async *stream(req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        const model = this.resolveModel();
        const apiKey = this.resolveApiKey();
        const meta: PiModelMeta = {
            api: (model as { api?: string }).api ?? this.provider,
            provider: this.provider,
            model: this.modelId,
        };
        const context = buildPiContext({
            systemPrompt: req.context.systemPrompt,
            messages: req.context.messages,
            tools: req.context.tools,
            meta,
        });
        const stream = this.models.stream(model, context, apiKey ? { apiKey } : undefined);
        for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
            for (const mapped of translatePiEvent(event)) {
                yield mapped;
            }
        }
    }

    async complete(req: LLMRequest): Promise<LLMResponse> {
        const model = this.resolveModel();
        const apiKey = this.resolveApiKey();
        const meta: PiModelMeta = {
            api: (model as { api?: string }).api ?? this.provider,
            provider: this.provider,
            model: this.modelId,
        };
        const context = buildPiContext({
            systemPrompt: req.context.systemPrompt,
            messages: req.context.messages,
            tools: req.context.tools,
            meta,
        });
        const assistant = await this.models.complete(
            model,
            context,
            apiKey ? { apiKey } : undefined,
        );
        const text = assistant.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('');
        return {
            content: text,
            finishReason: mapFinishReason(assistant.stopReason),
            usage: toVendorUsage(assistant.usage),
            model: {
                providerId: this.provider,
                vendor: this.provider,
                modelId: this.modelId,
            },
        };
    }

    private resolveModel(): Model<Api> {
        if (!this.modelHandle) {
            const found = this.models.getModel(this.provider, this.modelId);
            if (!found) {
                throw new Error(
                    `pi-ai 未找到模型：provider=${this.provider}, model=${this.modelId}（请检查 driver.provider/driver.model 配置）`,
                );
            }
            this.modelHandle = found;
        }
        return this.modelHandle;
    }

    /**
     * 凭据解析：
     * - 显式配置 apiKeyEnv → 缺失即抛错（PA-A3）；
     * - 未显式配置 → 按 provider 默认 env 名读取（openai→OPENAI_API_KEY、deepseek→DEEPSEEK_API_KEY 等），
     *   命中映射但缺失 → 抛清晰错误；
     * - 未命中映射的 provider（如 faux / 无鉴权自定义端点）→ 不校验，交由 pi-ai/端点决定。
     */
    private resolveApiKey(): string | undefined {
        if (this.apiKeyEnv !== undefined) {
            const value = process.env[this.apiKeyEnv];
            if (!value) {
                throw new Error(`pi-ai 驱动缺少 API key：请在环境变量 ${this.apiKeyEnv} 提供`);
            }
            return value;
        }
        const defaultEnv = DEFAULT_API_KEY_ENV[this.provider];
        if (defaultEnv !== undefined) {
            const value = process.env[defaultEnv];
            if (!value) {
                throw new Error(
                    `pi-ai 驱动缺少 API key：provider=${this.provider} 未配置环境变量 ${defaultEnv}（可用 driver.apiKeyEnv 指定其它变量名）`,
                );
            }
            return value;
        }
        return undefined;
    }
}
