import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    LLMProvider,
    LLMRequest,
    StreamCompletionEvent,
    SystemPrompt,
} from '@mazi/core';
import { ProviderError } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { loadRuntimeConfig, saveRuntimeSettings } from '../src/configs/index.js';
import { HarnessRuntime } from '../src/harness/index.js';
import {
    AGENT_PROMPT_IDS,
    DEFAULT_AGENT_PROMPTS,
    defaultAgentPrompt,
    listAgentPromptViews,
    resolveAgentPrompt,
    resolveBaseAgentPrompt,
} from '../src/prompts/agent-prompts.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-agent-prompts-'));
    dirs.push(dir);
    return dir;
}

function systemText(system: SystemPrompt | undefined): string {
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .map((block) => (block.type === 'text' ? block.text : ''))
            .join('\n');
    }
    return '';
}

function capturingProvider(seen: string[]): LLMProvider {
    return {
        id: 'faux',
        name: 'faux',
        defaultModel: 'faux-model',
        models: [],
        async ask() {
            throw new ProviderError('unknown', 'ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            seen.push(systemText(request.system));
            yield { type: 'start', model: 'faux-model' };
            yield { type: 'text_delta', text: 'answer' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function configIn(dir: string, agentPrompts?: RuntimeConfig['agentPrompts']): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
        ...(agentPrompts !== undefined ? { agentPrompts } : {}),
    };
}

describe('Agent 系统提示默认值与解析优先级', () => {
    it('每个已知 Agent 都有内置默认提示', () => {
        expect(new Set(DEFAULT_AGENT_PROMPTS.map((item) => item.id))).toEqual(
            new Set(AGENT_PROMPT_IDS),
        );
        for (const id of AGENT_PROMPT_IDS) {
            expect(defaultAgentPrompt(id).trim().length).toBeGreaterThan(0);
        }
    });

    it('未配置返回内置默认，配置优先，空白配置回落默认', () => {
        expect(resolveAgentPrompt('intent')).toBe(defaultAgentPrompt('intent'));
        expect(resolveAgentPrompt('intent', { intent: '自定义意图提示' })).toBe('自定义意图提示');
        expect(resolveAgentPrompt('intent', { intent: '   ' })).toBe(defaultAgentPrompt('intent'));
        expect(resolveAgentPrompt('intent', { main: '其它 Agent 的配置' })).toBe(
            defaultAgentPrompt('intent'),
        );
    });

    it('主执行面按 main → default → 内置 的顺序回退', () => {
        expect(resolveBaseAgentPrompt()).toBe(defaultAgentPrompt('main'));
        expect(resolveBaseAgentPrompt({ default: '默认 Agent 提示' })).toBe('默认 Agent 提示');
        expect(resolveBaseAgentPrompt({ main: '主 Agent 提示', default: '默认 Agent 提示' })).toBe(
            '主 Agent 提示',
        );
        expect(resolveBaseAgentPrompt({ main: '   ', default: '默认 Agent 提示' })).toBe(
            '默认 Agent 提示',
        );
    });

    it('视图标记来源并给出实际生效文本', () => {
        const views = listAgentPromptViews({ main: '自定义主提示', intent: '' });
        const main = views.find((view) => view.id === 'main');
        const intent = views.find((view) => view.id === 'intent');
        expect(main).toMatchObject({
            source: 'config',
            override: '自定义主提示',
            effectivePrompt: '自定义主提示',
        });
        expect(intent).toMatchObject({
            source: 'default',
            effectivePrompt: defaultAgentPrompt('intent'),
        });
        expect(intent?.override).toBeUndefined();
    });
});

describe('settings.json prompts 段持久化', () => {
    it('保存后随 RuntimeConfig 加载，并与既有配置合并', () => {
        const dir = tmp();
        saveRuntimeSettings({ prompts: { main: '主 Agent 提示' } }, dir);
        saveRuntimeSettings({ prompts: { intent: '意图提示' } }, dir);
        saveRuntimeSettings({ goal: { permissionCeiling: 'workspace-write' } }, dir);

        const config = loadRuntimeConfig(dir);
        expect(config.agentPrompts).toEqual({ main: '主 Agent 提示', intent: '意图提示' });
        expect(config.goal?.permissionCeiling).toBe('workspace-write');
    });

    it('空白值不写入配置（等价于恢复默认）', () => {
        const dir = tmp();
        saveRuntimeSettings({ prompts: { main: '   ', intent: '意图提示' } }, dir);
        expect(loadRuntimeConfig(dir).agentPrompts).toEqual({ intent: '意图提示' });
    });
});

describe('运行时使用配置后的系统提示', () => {
    it('主执行面使用 prompts.main，意图解析使用 prompts.intent', async () => {
        const dir = tmp();
        const seen: string[] = [];
        const runtime = new HarnessRuntime(
            configIn(dir, { main: 'CUSTOM MAIN PROMPT', intent: 'CUSTOM INTENT PROMPT' }),
            { llmProviders: { default: capturingProvider(seen) } },
        );
        try {
            const created = await runtime.createGoalSession('帮我看看这个项目', {
                parseIntent: true,
            });
            await runtime.executeGoalTree(created.rootGoalId);
        } finally {
            await runtime.close();
        }
        expect(seen.some((text) => text.includes('CUSTOM INTENT PROMPT'))).toBe(true);
        expect(seen.some((text) => text.includes('CUSTOM MAIN PROMPT'))).toBe(true);
        expect(seen.some((text) => text.includes(defaultAgentPrompt('intent')))).toBe(false);
    });

    it('未配置主提示时使用内置 GENERAL 提示', async () => {
        const dir = tmp();
        const seen: string[] = [];
        const runtime = new HarnessRuntime(configIn(dir), {
            llmProviders: { default: capturingProvider(seen) },
        });
        try {
            const created = await runtime.createGoalSession('你好');
            await runtime.executeGoalTree(created.rootGoalId);
        } finally {
            await runtime.close();
        }
        expect(seen.some((text) => text.includes(defaultAgentPrompt('main')))).toBe(true);
    });
});
