import { estimateTokens } from '../token-estimator.js';
import { CORE_PROMPT, DEFAULT_PROMPT_PACKS } from './defaults.js';
import type {
    PromptMatchContext,
    PromptMatchResult,
    PromptPack,
    PromptPackStore,
    PromptPackTrace,
} from './types.js';

export interface PromptMatchOptions {
    threshold?: number;
    maxPacks?: number;
    totalBudgetTokens?: number;
}

function intersection(left: readonly string[] = [], right: readonly string[] = []): string[] {
    const values = new Set(left);
    return right.filter((value) => values.has(value));
}

function scorePack(pack: PromptPack, context: PromptMatchContext): PromptPackTrace {
    const reasons: string[] = [];
    let score = 0;
    if (
        context.projectId !== undefined &&
        pack.matcher.projectIds?.includes(context.projectId) === true
    ) {
        score += 1;
        reasons.push(`project:${context.projectId}`);
    }
    if (pack.matcher.taskKinds?.includes(context.taskKind) === true) {
        score += 0.8;
        reasons.push(`task:${context.taskKind}`);
    }
    const projectTags = intersection(pack.matcher.projectTags, context.projectTags);
    if (projectTags.length > 0) {
        score += Math.min(0.6, projectTags.length * 0.3);
        reasons.push(`projectTags:${projectTags.join(',')}`);
    }
    const tools = intersection(pack.matcher.toolNeeds, context.tools);
    if (tools.length > 0) {
        score += Math.min(0.6, tools.length * 0.2);
        reasons.push(`tools:${tools.join(',')}`);
    }
    if (
        context.riskLevel !== undefined &&
        pack.matcher.riskLevels?.includes(context.riskLevel) === true
    ) {
        score += 0.9;
        reasons.push(`risk:${context.riskLevel}`);
    }
    if (context.explicitPackIds?.includes(pack.id) === true) {
        score += 2;
        reasons.push('explicit');
    }
    return { packId: pack.id, version: pack.version, score, reasons };
}

function renderPack(pack: PromptPack, remaining: number): string {
    const blocks = [
        pack.module.trim(),
        ...(pack.projectRules !== undefined && pack.projectRules.length > 0
            ? [`### 项目规则\n${pack.projectRules.map((item) => `- ${item}`).join('\n')}`]
            : []),
        ...(pack.examples !== undefined && pack.examples.length > 0
            ? [`### 示例\n${pack.examples.map((item) => `- ${item}`).join('\n')}`]
            : []),
    ];
    const text = blocks.join('\n\n');
    if (estimateTokens(text) <= (pack.budgetTokens ?? remaining)) return text;
    return pack.module.trim();
}

/**
 * Prompt Pack registry and deterministic minimal matcher.
 * Core prompt and index are always stable; only matched modules enter L2.
 */
export class PromptPackRegistry {
    private readonly packs = new Map<string, PromptPack>();

    constructor(
        initial: readonly PromptPack[] = DEFAULT_PROMPT_PACKS,
        private readonly store?: PromptPackStore,
    ) {
        for (const pack of initial) this.storePack(pack);
        for (const pack of store?.load() ?? []) this.storePack(pack);
    }

    register(pack: PromptPack): void {
        this.assertPack(pack);
        this.store?.save(structuredClone(pack));
        this.storePack(pack);
    }

    remove(id: string): boolean {
        const existing = this.packs.get(id);
        if (existing === undefined || existing.enabled === false) return false;
        this.storePack({ ...existing, enabled: false });
        this.store?.save(structuredClone({ ...existing, enabled: false }));
        return true;
    }

    close(): void {
        this.store?.close();
    }

    private assertPack(pack: PromptPack): void {
        if (pack.id.trim().length === 0) throw new Error('PromptPack id 必填');
        if (pack.module.trim().length === 0) throw new Error(`PromptPack ${pack.id} 缺少 module`);
    }

    private storePack(pack: PromptPack): void {
        this.assertPack(pack);
        this.packs.set(pack.id, structuredClone(pack));
    }

    list(): PromptPack[] {
        return [...this.packs.values()]
            .filter((pack) => pack.enabled !== false)
            .sort((left, right) => left.id.localeCompare(right.id))
            .map((pack) => structuredClone(pack));
    }

    match(context: PromptMatchContext, options: PromptMatchOptions = {}): PromptMatchResult {
        const threshold = options.threshold ?? 0.3;
        const maxPacks = options.maxPacks ?? 2;
        const totalBudget = options.totalBudgetTokens ?? 1400;
        const scored = this.list()
            .map((pack) => ({ pack, trace: scorePack(pack, context) }))
            .filter((item) => item.trace.score >= threshold)
            .sort(
                (left, right) =>
                    right.trace.score - left.trace.score ||
                    (right.pack.priority ?? 0) - (left.pack.priority ?? 0) ||
                    left.pack.id.localeCompare(right.pack.id),
            );
        const minimal = scored.some((item) => item.pack.id !== 'general')
            ? scored.filter((item) => item.pack.id !== 'general')
            : scored;
        const ranked = minimal.slice(0, maxPacks);

        const conflicts = new Set<string>();
        const selected: PromptPack[] = [];
        const trace: PromptPackTrace[] = [];
        for (const item of ranked) {
            if (
                selected.some(
                    (pack) =>
                        pack.conflictsWith?.includes(item.pack.id) === true ||
                        item.pack.conflictsWith?.includes(pack.id) === true,
                )
            ) {
                conflicts.add(item.pack.id);
                continue;
            }
            selected.push(item.pack);
            trace.push(item.trace);
        }

        const index = `## 可用 PromptPack\n${this.list()
            .map((pack) => `- ${pack.name} (${pack.id}): ${pack.description}`)
            .join('\n')}`;
        const blocks = [CORE_PROMPT, index];
        let tokens = estimateTokens(blocks.join('\n\n'));
        for (const pack of selected) {
            const rendered = renderPack(pack, Math.max(0, totalBudget - tokens));
            const cost = estimateTokens(rendered);
            if (tokens + cost > totalBudget) continue;
            blocks.push(rendered);
            tokens += cost;
        }
        return {
            corePrompt: CORE_PROMPT,
            index,
            selected,
            prompt: blocks.join('\n\n'),
            trace: trace.filter((item) => !conflicts.has(item.packId)),
            estimatedTokens: tokens,
        };
    }
}
