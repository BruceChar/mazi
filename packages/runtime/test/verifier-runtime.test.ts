import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, type LLMProvider, type LLMRequest, type StreamCompletionEvent } from '@mazi/core';
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
            return {
                model: 'scripted',
                content: [{ type: 'text', text: '基于证据完成的答案' }],
                finishReason: 'stop',
            };
        },
        async *askStream(_request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            yield { type: 'text_delta', text: '基于证据完成的答案' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function config(): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: mkdtempSync(join(tmpdir(), 'mazi-verifier-')),
        goal: { allowedTools: [] },
        contextWindow: 32_000,
    };
}

describe('Runtime independent verifier integration', () => {
    it('runs semantic judge, persists acceptance and emits verification event', async () => {
        const llm = provider();
        const runtime = new HarnessRuntime(config(), { llmProviders: { default: llm } });
        const judgeCalls: string[] = [];
        runtime.setSemanticJudge({
            id: 'judge-test',
            async judge(request) {
                judgeCalls.push(request.conditionId);
                return { status: 'passed', confidence: 0.88, reason: '有证据' };
            },
        });
        try {
            const created = await runtime.createGoalSession('完成任务', {
                llmProviders: { default: llm },
                maxSteps: 2,
            });
            const goal = await runtime.goalStore.loadGoal(created.rootGoalId);
            expect(goal).toBeDefined();
            const semanticId = ulid();
            goal!.contract.successConditions.push({
                id: semanticId,
                checkType: 'semantic',
                description: '答案必须基于证据',
            });
            await runtime.goalStore.saveGoal(goal!);

            const result = await runtime.executeGoalTree(created.rootGoalId);
            expect(judgeCalls).toContain(semanticId);
            expect(result.tasks[0]?.task.acceptanceResult?.conditions).toContainEqual(
                expect.objectContaining({ conditionId: semanticId, status: 'passed' }),
            );
            const verification = runtime.eventBus
                .replay(created.rootGoalId)
                .find((event) => event.type === 'verification.completed');
            expect(verification?.payload).toMatchObject({
                verifierId: 'independent-default',
                semanticJudgeId: 'judge-test',
                state: 'passed',
            });
            expect(runtime.verifierInfo()).toEqual({
                id: 'independent-default',
                semanticJudge: true,
            });
        } finally {
            await runtime.close();
        }
    });
});
