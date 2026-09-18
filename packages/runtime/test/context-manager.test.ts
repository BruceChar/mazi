import { describe, expect, it } from 'vitest';

import type { LLMMessage } from '@mazi/core';
import { authz } from '@mazi/core';

import {
    ContextManager,
    parseSecretRef,
    SecretRedactionUnavailableError,
    secretServiceRedactor,
    serializeSecretRef,
} from '../src/harness/context-manager.js';

const assistantMessage = (text: string): LLMMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
});
const userMessage = (text: string): LLMMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
});

describe('ContextManager composition', () => {
    it('dynamically joins system prompt, messages and tools from contributions', () => {
        const manager = new ContextManager({
            systemPrompt: 'base',
            tools: [{ name: 'a', description: 'a' }],
            history: [assistantMessage('h')],
            contributions: [
                {
                    id: 'one',
                    systemPrompt: () => 'frag-1',
                    messages: () => [userMessage('ctx-1')],
                    tools: () => [{ name: 'b', description: 'b' }],
                },
                {
                    id: 'two',
                    systemPrompt: () => undefined,
                    messages: () => [userMessage('ctx-2')],
                    tools: () => [{ name: 'a', description: 'a2' }],
                },
            ],
        });
        manager.appendUser('input');

        expect(manager.systemPrompt()).toBe('base\n\nfrag-1');
        expect(manager.messages().map((message) => message.role)).toEqual([
            'assistant',
            'user',
            'user',
            'user',
        ]);
        expect(manager.baseMessageCount()).toBe(3);
        const tools = manager.tools();
        expect(tools.map((tool) => tool.name)).toEqual(['a', 'b']);
        expect(tools.find((tool) => tool.name === 'a')?.description).toBe('a2');
    });

    it('supports adding and removing contributions at runtime', () => {
        const manager = new ContextManager();
        manager.addContribution({ id: 'c', systemPrompt: () => 'x' });
        expect(manager.systemPrompt()).toBe('x');
        expect(manager.removeContribution('c')).toBe(true);
        expect(manager.systemPrompt()).toBeUndefined();
        expect(manager.removeContribution('c')).toBe(false);
    });
});

describe('ContextManager rounds', () => {
    it('appends user/assistant/tool messages in order and tracks the base count', () => {
        const manager = new ContextManager({ history: [assistantMessage('h')] });
        manager.appendUser('q');
        manager.appendAssistant({
            text: 'a',
            toolCalls: [{ callId: 'c1', name: 't', arguments: { x: 1 } }],
        });
        manager.appendToolResults([{ callId: 'c1', output: 'o' }]);

        expect(manager.messages().map((message) => message.role)).toEqual([
            'assistant',
            'user',
            'assistant',
            'tool',
        ]);
        expect(manager.baseMessageCount()).toBe(1);
        expect(manager.dynamicMessageCount()).toBe(3);
    });

    it('truncates assistant text on write-back', () => {
        const manager = new ContextManager({ assistantTextMax: 3 });
        manager.appendAssistant({ text: '12345', toolCalls: [] });
        const assistant = manager.messages()[0];
        expect(assistant?.role).toBe('assistant');
        if (assistant?.role === 'assistant') {
            expect(assistant.content).toEqual([{ type: 'text', text: '123' }]);
        }
    });

    it('measures cross-round delta and exposes the compaction decision point', () => {
        const manager = new ContextManager({ systemPrompt: 'sys' });
        manager.appendUser('hello');
        const first = manager.measure(1_000_000);
        expect(first.totalContextTokens).toBeGreaterThan(0);

        manager.appendAssistant({ text: 'world', toolCalls: [] });
        const second = manager.measure(1_000_000);
        expect(second.contextDeltaFromPrev).toBeGreaterThan(0);
        expect(manager.shouldCompact(1)).toBe(true);
        expect(manager.shouldCompact(1_000_000)).toBe(false);
        expect(manager.shouldCompact(0)).toBe(false);
    });

    it('resets dynamic messages and the measurement baseline', () => {
        const manager = new ContextManager();
        manager.appendUser('x');
        manager.measure(1000);
        manager.reset();
        expect(manager.dynamicMessageCount()).toBe(0);
    });
});

describe('ContextManager secret severance', () => {
    it('redacts a secret observation into a voucher', () => {
        const manager = new ContextManager({
            redactor: {
                redact: () => ({ handle: 'secretref:x', attributes: { kind: 'api-key' } }),
            },
        });
        manager.appendToolResults([
            { callId: 'c', output: 'PLAINTEXT-SECRET', sensitivity: 'secret' },
        ]);
        const tool = manager.messages()[0];
        expect(tool?.role).toBe('tool');
        if (tool?.role === 'tool') {
            const output = tool.results[0]?.output;
            expect(typeof output).toBe('string');
            expect(output).not.toContain('PLAINTEXT-SECRET');
            expect(parseSecretRef(output as string)).toEqual({
                handle: 'secretref:x',
                attributes: { kind: 'api-key' },
            });
        }
    });

    it('passes through an already-severed voucher without a redactor', () => {
        const voucher = serializeSecretRef({ handle: 'secretref:y', attributes: {} });
        const manager = new ContextManager();
        manager.appendToolResults([{ callId: 'c', output: voucher, sensitivity: 'secret' }]);
        const tool = manager.messages()[0];
        if (tool?.role === 'tool') expect(tool.results[0]?.output).toBe(voucher);
    });

    it('fails closed when a secret observation has no redactor', () => {
        const manager = new ContextManager();
        expect(() =>
            manager.appendToolResults([
                { callId: 'c', output: 'PLAINTEXT-SECRET', sensitivity: 'secret' },
            ]),
        ).toThrow(SecretRedactionUnavailableError);
    });

    it('adapts authz SecretService into a redactor', () => {
        const service = new authz.SecretService({
            sign: (_payload, material) => 'sig:' + material.length,
        });
        const redactor = secretServiceRedactor(service, () => ({
            refId: 'ref-1',
            allowedSinks: ['net.send'],
            purpose: {
                service: 's3',
                actions: ['GetObject'],
                resourcePattern: 'arn:aws:s3:::bucket/*',
            },
        }));
        const manager = new ContextManager({ redactor });
        manager.appendToolResults([
            { callId: 'c', output: 'AKIAEXAMPLE', sensitivity: 'secret' },
        ]);
        const tool = manager.messages()[0];
        if (tool?.role !== 'tool') throw new Error('expected tool message');
        const ref = parseSecretRef(tool.results[0]?.output as string);
        expect(ref?.handle).toBe('secretref:ref-1');
        expect(tool.results[0]?.output).not.toContain('AKIAEXAMPLE');
    });
});
