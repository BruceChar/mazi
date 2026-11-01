import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/runtime.js';

function provider(): LLMProvider {
    return {
        id: 'default',
        name: 'scripted',
        defaultModel: 'scripted',
        models: [],
        async ask(_request: LLMRequest) {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            const userText = request.messages
                .filter((message) => message.role === 'user')
                .map((message) =>
                    message.content
                        .map((block) => (block.type === 'text' ? block.text : ''))
                        .join(''),
                )
                .join(' ');
            const hasToolResult = request.messages.some((message) => message.role === 'tool');
            if (userText.includes('协调子任务') && !hasToolResult) {
                yield { type: 'tool_call_start', index: 0, callId: 'd1', name: 'delegate' };
                yield {
                    type: 'tool_call_delta',
                    index: 0,
                    argumentsDelta: JSON.stringify({
                        delegations: [
                            { statement: '独立审查结果', roleId: 'reviewer', budget: { maxCostUsd: 1 } },
                        ],
                    }),
                };
                yield { type: 'tool_call_stop', index: 0 };
                yield { type: 'finish', finishReason: 'tool_calls' };
                return;
            }
            yield { type: 'text_delta', text: '父任务与子任务均完成' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function config(): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-delegation-')),
        goal: { allowedTools: undefined },
        contextWindow: 32_000,
    };
}

describe('delegate runtime tool', () => {
    it('executes a child Goal and records a delegation edge', async () => {
        const llm = provider();
        const runtime = new HarnessRuntime(config(), { llmProviders: { default: llm } });
        try {
            const run = await runtime.runGoalSession('协调子任务', {
                llmProviders: { default: llm },
                permissionCeiling: 'read-only',
                userId: 'u1',
                projectId: 'p1',
                maxCostUsd: 5,
                maxSteps: 4,
            });
            expect(run.result.ok).toBe(true);
            expect(run.result.tasks.at(-1)?.finalMessage).toContain('子任务');
            const edges = await runtime.delegationEdges(run.rootGoalId);
            expect(edges).toHaveLength(1);
            expect(edges[0]).toMatchObject({
                rootGoalId: run.rootGoalId,
                parentGoalId: run.rootGoalId,
                roleId: 'reviewer',
                permissionCeiling: 'read-only',
            });
            const events = runtime.eventBus.replay(run.rootGoalId);
            expect(events.some((event) => event.type === 'delegation.started')).toBe(true);
            expect(events.some((event) => event.type === 'delegation.completed')).toBe(true);
            expect(runtime.agentRoles().map((role) => role.roleId)).toContain('reviewer');
        } finally {
            await runtime.close();
        }
    });
});
