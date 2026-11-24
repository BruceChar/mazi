/**
 * V5 适配层（R1）：把 runtime 工具调用映射为 core v5 Op，交由 `authz.decide`
 * 七行链判定。本适配器只做保守映射，不替代完整分类器：object 缺省 unknown
 * （unproven → hazard 询问），目标事实由装配层注入。旧 v3 网关路径保持不动。
 */

import { authz } from '@mazi/core';

import type { ToolConfig } from '../config.js';

type V5Op = authz.Op;
type V5DecisionContext = authz.DecisionContext;
type V5Decision = authz.Decision;

export interface V5AdapterInput {
    tool: ToolConfig;
    args: Record<string, unknown>;
    channel?: V5Op['channel'];
    attested?: V5Op['attested'];
    target?: string;
    object?: V5Op['object'];
    data?: V5Op['data'];
    q1?: V5Op['q1'];
    envelope?: boolean;
    originChain?: boolean;
    targetFresh?: boolean;
}

function mapAction(tool: ToolConfig): V5Op['action'] {
    if (tool.name === 'shell.run') return 'exec';
    if (tool.sideEffects.includes('net')) return 'egress';
    if (tool.irreversible || tool.sideEffects.includes('fs')) return 'write';
    return 'read';
}

export function buildV5Op(input: V5AdapterInput): V5Op {
    const action = mapAction(input.tool);
    const q1 = input.q1 ?? (input.tool.irreversible ? 'irreversible' : 'compensable');
    return {
        action,
        target: input.target ?? '',
        object: input.object ?? 'unknown',
        data: input.data ?? 'clean',
        q1,
        envelope: input.envelope ?? false,
        originChain: input.originChain ?? false,
        targetFresh: input.targetFresh ?? action === 'egress',
        channel: input.channel ?? 'agent',
        attested: input.attested ?? 'none',
        unparsed: false,
    };
}

export function v5Decide(op: V5Op, ctx: V5DecisionContext): V5Decision {
    return authz.decide(op, ctx);
}
