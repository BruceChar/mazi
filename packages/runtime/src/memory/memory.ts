/**
 * memory/memory.ts —— 记忆调度策略（memory 层）。
 *
 * memory 与 store 是两个概念：store 负责落库交互，memory 负责“长期记忆 ↔ context”
 * 之间的调度——召回什么、按什么预算裁剪、以什么形态注入 ContextManager。
 */

import { createHash } from 'node:crypto';
import type { LLMMessage } from '@mazi/core';
import { ulid } from '@mazi/core';

import type { ContextContribution } from '../harness/context-manager.js';
import { estimateTokens } from '../token-estimator.js';
import {
    InMemoryMemoryStore,
    type MemoryItem,
    type MemoryProvenance,
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
            // 同一内容只保留最新一条：历史轮次被重复回写会产生多条同文记忆，
            // 不去重会白占 limit 与 token 预算，把别的记忆挤出去。
            const byContent = new Map<string, MemoryItem>();
            for (const item of byId.values()) {
                // 老数据（turn）没有 contentHash：用 kind|role|text 兜底，照样折叠重复。
                const key = item.contentHash ?? `${item.kind}|${item.role ?? ''}|${item.text}`;
                const existing = byContent.get(key);
                if (existing === undefined || existing.createdAt < item.createdAt) {
                    byContent.set(key, item);
                }
            }
            const ordered = [...byContent.values()].sort((a, b) => a.createdAt - b.createdAt);
            const limit = input.limit ?? maxItems;
            const budget = input.budgetTokens;
            const queryText = input.queryText?.trim().toLowerCase();
            if (queryText !== undefined && queryText.length > 0) {
                const now = Math.max(...ordered.map((item) => item.createdAt), Date.now());
                const candidates = ordered
                    .map((item) => ({ item, score: memoryScore(item, input, queryText, now) }))
                    .sort(
                        (left, right) =>
                            right.score - left.score ||
                            right.item.createdAt - left.item.createdAt ||
                            left.item.id.localeCompare(right.item.id),
                    );
                const selected: MemoryItem[] = [];
                let used = 0;
                for (const candidate of candidates) {
                    if (selected.length >= limit) break;
                    const cost = estimateTokens(candidate.item.text);
                    if (budget !== undefined && budget > 0 && used + cost > budget) continue;
                    selected.push(candidate.item);
                    used += cost;
                }
                return selected.sort((a, b) => a.createdAt - b.createdAt);
            }
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

function queryTokens(text: string): Set<string> {
    const normalized = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
    for (const chunk of normalized.replace(/\s+/g, '').matchAll(/[\p{Script=Han}]{2}/gu)) {
        tokens.push(chunk[0]);
    }
    return new Set(tokens);
}

function memoryScore(item: MemoryItem, input: RecallInput, queryText: string, now: number): number {
    const text = `${item.text} ${(item.tags ?? []).join(' ')}`.toLowerCase();
    const query = queryTokens(queryText);
    const content = queryTokens(text);
    let overlap = 0;
    for (const token of query) if (content.has(token)) overlap += 1;
    const lexical = query.size === 0 ? 0 : overlap / query.size;
    const ageDays = Math.max(0, now - item.createdAt) / 86_400_000;
    const recency = 0.5 ** (ageDays / 30);
    const importance = Math.max(0, Math.min(1, item.importance ?? 0.5));
    const trust = item.provenance?.confidence === 'confirmed' ? 1 : 0.55;
    const projectBoost =
        input.projectId !== undefined &&
        (item.projectId === input.projectId ||
            item.links?.projectIds?.includes(input.projectId) === true)
            ? 0.2
            : 0;
    const stalePenalty = item.provenance?.confidence === 'pending_confirmation' ? 0.15 : 0;
    return (
        lexical * 0.45 +
        recency * 0.2 +
        importance * 0.2 +
        trust * 0.15 +
        projectBoost -
        stalePenalty
    );
}

/** 会话轮次记忆的最小形态（与 ConversationTurn 同构）。 */
export interface MemoryTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface TurnsToMemoryOptions {
    rootGoalId?: string;
    conversationId?: string;
    userId?: string;
    workspaceId?: string;
    projectId?: string;
    tags?: readonly string[];
    provenance?: MemoryProvenance;
    now?: () => number;
    id?: (index: number) => string;
}

/**
 * 会话轮次的稳定 id：同会话、同角色、同文本 → 同 id。
 * 续聊每轮都会把此前历史重新回写一次，稳定 id 让 store 按 id upsert，
 * 而不是每次都追加一份内容相同的新记忆。
 */
function turnIdOf(conversationId: string, turn: MemoryTurn): string {
    const digest = createHash('sha256')
        .update(`${conversationId}\u0000${turn.role}\u0000${turn.text}`)
        .digest('hex')
        .slice(0, 40);
    return `turn-${digest}`;
}

/** Conversation 轮次 -> MemoryItem，按输入顺序给出递增 createdAt，id 保证唯一。 */
export function turnsToMemory(
    turns: readonly MemoryTurn[],
    opts: TurnsToMemoryOptions = {},
): MemoryItem[] {
    const now = opts.now ?? Date.now;
    const base = now();
    return turns.map((turn, index) => ({
        id:
            opts.id?.(index) ??
            (opts.conversationId !== undefined ? turnIdOf(opts.conversationId, turn) : ulid()),
        kind: 'turn' as const,
        role: turn.role,
        text: turn.text,
        createdAt: base + index,
        ...(opts.rootGoalId !== undefined ? { rootGoalId: opts.rootGoalId } : {}),
        ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
        ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
        ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
        ...(opts.tags !== undefined ? { tags: [...opts.tags] } : {}),
        ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
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

    /** 释放底层存储（runtime close 时调用；内存实现为空操作）。 */
    close(): void {
        this.store.close();
    }

    async remember(items: readonly MemoryItem[]): Promise<void> {
        if (items.length === 0) return;
        await this.store.append(items);
    }

    async recall(input: RecallInput = {}): Promise<readonly MemoryItem[]> {
        let recalled: readonly MemoryItem[];
        if (input.unionScope === true) {
            const queries: MemoryQuery[] = [];
            if (input.rootGoalId !== undefined) {
                queries.push({ rootGoalId: input.rootGoalId, status: input.status });
            }
            if (input.conversationId !== undefined) {
                queries.push({ conversationId: input.conversationId, status: input.status });
            }
            // user/workspace/project 是跨会话共享的长期资产（summary/fact/preference）。
            // 对话轮次（turn）只属于某个会话：必须在宽作用域里排除，否则同工作区的
            // 别的会话的问答会被当成“历史”注入当前上下文（线上曾把天气问答漏进无关会话）。
            const wideScope = { status: input.status, excludeKinds: ['turn'] as const };
            if (input.userId !== undefined) {
                queries.push({ ...wideScope, userId: input.userId });
            }
            if (input.workspaceId !== undefined) {
                queries.push({ ...wideScope, workspaceId: input.workspaceId });
            }
            if (input.projectId !== undefined) {
                queries.push({ ...wideScope, projectId: input.projectId });
            }
            if (queries.length === 0) queries.push({ status: input.status });
            const byId = new Map<string, MemoryItem>();
            for (const query of queries) {
                for (const item of await this.store.recall(query)) byId.set(item.id, item);
            }
            recalled = [...byId.values()];
        } else {
            recalled = await this.store.recall(input);
        }
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

    /** Export-friendly immutable view of all records. */
    all(): Promise<readonly MemoryItem[]> {
        return this.store.all();
    }
}
