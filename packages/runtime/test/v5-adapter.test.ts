import { describe, expect, it } from 'vitest';

import { authz } from '@mazi/core';

import type { ToolConfig } from '../src/config.js';
import { buildV5Op, v5Decide } from '../src/tool-gateway/v5-adapter.js';

function tool(partial: Partial<ToolConfig> & Pick<ToolConfig, 'name'>): ToolConfig {
    return {
        description: partial.name,
        parameters: { type: 'object', properties: {} },
        minPermission: 'read-only',
        sideEffects: [],
        ...partial,
    };
}

const EMPTY_CTX: authz.DecisionContext = {
    isBlocked: () => false,
    memoryHit: () => false,
    routineHit: () => false,
    passthrough: () => false,
};

describe('buildV5Op 工具调用 → v5 Op 映射（R1）', () => {
    it('只读工具 → action=read，默认非 hazard', () => {
        const op = buildV5Op({ tool: tool({ name: 'rg' }), args: {} });
        expect(op.action).toBe('read');
        expect(op.q1).toBe('compensable');
    });

    it('shell.run → action=exec', () => {
        const op = buildV5Op({ tool: tool({ name: 'shell.run' }), args: {} });
        expect(op.action).toBe('exec');
    });

    it('net 副作用 → action=egress，目标新鲜（targetFresh）', () => {
        const op = buildV5Op({ tool: tool({ name: 'xh', sideEffects: ['net'] }), args: {} });
        expect(op.action).toBe('egress');
        expect(op.targetFresh).toBe(true);
    });

    it('irreversible 工具 → q1=irreversible → hazard ask', () => {
        const op = buildV5Op({
            tool: tool({ name: 'sd', irreversible: true, sideEffects: ['fs'] }),
            args: {},
        });
        expect(op.q1).toBe('irreversible');
        expect(v5Decide(op, EMPTY_CTX)).toBe('ask');
    });

    it('通道与锚定可覆盖：默认 agent/none，不直通', () => {
        const op = buildV5Op({ tool: tool({ name: 'rg' }), args: {} });
        expect(op.channel).toBe('agent');
        expect(op.attested).toBe('none');
    });

    it('普通工作区读经 v5Decide → auto（auto_log）', () => {
        const op = buildV5Op({
            tool: tool({ name: 'rg' }),
            args: {},
            object: 'source',
        });
        expect(v5Decide(op, EMPTY_CTX)).toBe('auto');
    });
});
