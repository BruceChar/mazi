/**
 * memory/memory.ts —— 记忆调度策略（memory 层）。
 *
 * memory 与 store 是两个概念：store 负责落库交互，memory 负责“长期记忆 ↔ context”
 * 之间的调度——召回什么、按什么预算裁剪、以什么形态注入 ContextManager。
 */

import type { LLMMessage } from '@mazi/core';
import { ulid } from '@mazi/core';

import type { ContextContribution } from '../harness/context-manager.js';
import { estimateTokens } from '../token-estimator.js';
import {
    InMemoryMemoryStore,
    type MemoryItem,
    type MemoryQuery,
    type MemoryStore,
} from './store.js';

export interface RecallInput extends MemoryQuery {
    /** 可注入 context 的 token 预算；优先于构造时的默认预算。 */
    budgetTokens?: number;
}

/** 调度策略：把召回集裁剪为适合注入 context 的记忆（保持时间序）。 */
export interface MemoryPolicy {
    select(items: readonly MemoryItem[], input: RecallInput): readonly MemoryItem[];
}

export interface RecentMemoryPolicyOptions {
    /** 默认最多保留的记忆条数。 */
    maxItems?: number;
}

/** 默认策略：保序、按 id 去重、从最新往回填充 token 预算。 */
export function recentMemoryPolicy(opts: RecentMemoryPolicyOptions = {}): MemoryPolicy {
    const maxItems = opts.maxItems ?? 20;
    return {
        select(items, input) {
            const byId = new Map<string, MemoryItem>();
            for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
                byId.set(item.id, item);
            }
            const ordered = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
            const limit = input.limit ?? maxItems;
            const budget = input.budgetTokens;
            if (budget === undefined || budget <= 0) return ordered.slice(-limit);
            const kept: MemoryItem[] = [];
            let used = 0;
            for (let i = ordered.length - 1; i >= 0 && kept.length < limit; i -= 1) {
                const item = ordered[i];
                if (item === undefined) continue;
                const cost = estimateTokens(item.text);
                if (kept.length > 0 && used + cost > budget) continue;
                kept.push(item);
                used += cost;
            }
            return kept.reverse();
        },
    };
}

/** 会话轮次记忆的最小形态（与 ConversationTurn 同构）。 */
export interface MemoryTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface TurnsToMemoryOptions {
    rootGoalId?: string;
    conversationId?: string;
    now?: () => number;
    id?: (index: number) => string;
}

/** Conversation 轮次 -> MemoryItem，按输入顺序给出递增 createdAt，id 保证唯一。 */
export function turnsToMemory(
    turns: readonly MemoryTurn[],
    opts: TurnsToMemoryOptions = {},
): MemoryItem[] {
    const now = opts.now ?? Date.now;
    const base = now();
    return turns.map((turn, index) => ({
        id: opts.id?.(index) ?? ulid(),
        kind: 'turn' as const,
        role: turn.role,
        text: turn.text,
        createdAt: base + index,
        ...(opts.rootGoalId !== undefined ? { rootGoalId: opts.rootGoalId } : {}),
        ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
    }));
}

export interface MemoryManagerOptions {
    store?: MemoryStore;
    policy?: MemoryPolicy;
    /** 默认 token 预算（可被 recall 的 budgetTokens 覆盖）。 */
    budgetTokens?: number;
}

/**
 * 记忆调度组合根：对接 store（持久化）与 ContextManager（上下文）。
 * 具体“召回什么”由 MemoryPolicy 决定，本类只做编排。
 */
export class MemoryManager {
    private readonly store: MemoryStore;
    private readonly policy: MemoryPolicy;
    private readonly budgetTokens?: number;

    constructor(opts: MemoryManagerOptions = {}) {
        this.store = opts.store ?? new InMemoryMemoryStore();
        this.policy = opts.policy ?? recentMemoryPolicy();
        this.budgetTokens = opts.budgetTokens;
    }

    async remember(items: readonly MemoryItem[]): Promise<void> {
        if (items.length === 0) return;
        await this.store.append(items);
    }

    async recall(input: RecallInput = {}): Promise<readonly MemoryItem[]> {
        const recalled = await this.store.recall(input);
        const budget = input.budgetTokens ?? this.budgetTokens;
        return this.policy.select(recalled, {
            ...input,
            ...(budget !== undefined ? { budgetTokens: budget } : {}),
        });
    }

    /** 把召回快照转成 ContextContribution：turn -> 消息，summary/fact -> system 片段。 */
    toContribution(items: readonly MemoryItem[], opts: { id?: string } = {}): ContextContribution {
        const turns = items.filter((item) => item.kind === 'turn' && item.role !== undefined);
        const notes = items.filter((item) => item.kind !== 'turn' || item.role === undefined);
        const messages: LLMMessage[] = turns.map((item) =>
            item.role === 'user'
                ? { role: 'user', content: [{ type: 'text', text: item.text }] }
                : { role: 'assistant', content: [{ type: 'text', text: item.text }] },
        );
        const noteText = notes.map((item) => item.text).join('\n');
        return {
            id: opts.id ?? 'memory',
            ...(messages.length > 0
                ? { messages: () => messages.map((message) => ({ ...message })) }
                : {}),
            ...(noteText.length > 0 ? { systemPrompt: () => noteText } : {}),
        };
    }

    async prepareContribution(
        input: RecallInput = {},
        opts: { id?: string } = {},
    ): Promise<ContextContribution> {
        return this.toContribution(await this.recall(input), opts);
    }

    /** 清理记忆（会话销毁 / 测试）。 */
    async forget(query: MemoryQuery = {}): Promise<void> {
        await this.store.clear(query);
    }
}
