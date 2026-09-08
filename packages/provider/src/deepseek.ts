/**
 * DeepSeek Provider：厂商具体化（单入口）。
 *
 * 分层（自下而上）：
 *   pi-ai（@earendil-works/pi-ai）—— 协议实现 + 厂商目录（DeepSeek 模型表 / thinking 参数 /
 *     reasoning_content 回放要求等厂商知识全部内置，本包不再维护第二份）
 *   ↑ bridge（./pi-ai-adapter.ts）—— pi-ai ↔ LLMProvider 契约的唯一转换点
 *   ↑ provider（本文件）—— 只做"厂商具体化"：选 pi-ai 的 DeepSeek provider、绑定默认模型，
 *     产出裸 LLMProvider（bridge）。
 *
 * 组装约定：重试 / 超时 / 事件 / 监测等横切关注点由 client 层（./client.ts 的
 * createProviderClient）在 wiring 层（谁用谁包）完成，本文件不内置：
 *   const client = createProviderClient({ provider: createDeepSeekClient(), maxRetries: 2, onEvent });
 *
 * 设计决策：对外只有 createDeepSeekClient() 一个入口。
 *   不再暴露裸 provider 函数（createDeepSeekProvider）——那会给出第二条绕过
 *   观测/治理的调用路径，与能力层"单入口"原则一致。
 */

import { createModels } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import type { LLMProvider } from '@mazi/core';
import { createPiProvider } from './pi-ai-adapter.js';

/** DeepSeek API base URL（pi-ai 目录内置，此处仅作常量导出供参考 / 展示）。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** 现役模型（DeepSeek-V4 系列，模型元数据以 pi-ai 目录为准）。 */
export const DEEPSEEK_V4_FLASH = 'deepseek-v4-flash';
export const DEEPSEEK_V4_PRO = 'deepseek-v4-pro';

export const DEEPSEEK_DEFAULT_MODEL = DEEPSEEK_V4_FLASH;

export interface DeepSeekClientOptions {
    /** 显式 apiKey（缺省由 pi-ai 从 DEEPSEEK_API_KEY 环境变量解析）。 */
    apiKey?: string;
    /** 默认模型（默认 deepseek-v4-flash）。 */
    defaultModel?: string;
}

/**
 * 开箱即用的 DeepSeek Provider（唯一公开入口）：
 *   provider → bridge → pi-ai(deepseek)
 * 产出裸 LLMProvider；需要重试 / 超时 / 事件 / 监测时由 wiring 层用
 * createProviderClient（./client.ts）包装。
 */
export function createDeepSeekClient(options: DeepSeekClientOptions = {}): LLMProvider {
    // 组装（wiring）：注册 DeepSeek provider 到 Models 集合
    const models = createModels();
    models.setProvider(deepseekProvider());

    return createPiProvider({
        models,
        providerId: 'deepseek',
        defaultModel: options.defaultModel ?? DEEPSEEK_DEFAULT_MODEL,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    });
}
