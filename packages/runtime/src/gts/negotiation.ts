/**
 * negotiation —— 契约协商（goal-parser 契约的机械侧，docs/core/AHF_CORE_GTS.md §9）。
 *
 * 纯函数：解析模型的 JSON 输出 → 协商轨迹 + 冻结条款。
 * 解析失败或未接入解析模型 → fallback（默认执行），绝不猜意图。
 */

import type {
    CheckableCondition,
    ConditionCheck,
    GoalNegotiation,
    NegotiationAnswer,
    NegotiationQuestion,
    NegotiationRoute,
} from '@mazi/core';
import { isConditionCheck, ulid } from '@mazi/core';

/**
 * Structured constraint from triage: `text` stays the semantic statement;
 * a valid `check` upgrades the clause to checkType='deterministic'.
 */
export interface StructuredConstraint {
    text: string;
    check?: ConditionCheck;
}

/** goal-parser 模板约定的 block（字段按 route 收窄；解析期只做形状校验）。 */
export interface ParsedBlock {
    route: NegotiationRoute;
    goals?: string[];
    constraints?: (string | StructuredConstraint)[];
    understanding?: string[];
    defaultPath?: string[];
    approach?: { decomposition?: string; explorationBudget?: number; outputForm?: string };
    questions?: NegotiationQuestion[];
    conflicts?: string[];
    escalation?: string;
    answer?: string;
}

export interface ParsedGoalPlan {
    trace?: { classification?: string; triggers?: string[] };
    blocks: ParsedBlock[];
}

export interface NegotiationPlan {
    negotiation: GoalNegotiation;
    /** 冻结（或默认路径）条款：基线机械条款 + 解析出的条款（deterministic / semantic） */
    conditions: CheckableCondition[];
}

const PARSER_ROUTES: ReadonlySet<string> = new Set([
    'direct',
    'confirmed',
    'negotiate',
    'escalate',
]);

function textList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const items = value.filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
    );
    return items.length > 0 ? items : undefined;
}

/** Copy only known fields so model-supplied extras never leak into the contract. */
function cloneCheck(check: ConditionCheck): ConditionCheck {
    switch (check.kind) {
        case 'final-answer':
        case 'no-failed-steps':
        case 'git-has-commit':
            return { kind: check.kind };
        case 'file-exists':
            return { kind: 'file-exists', path: check.path };
        case 'file-contains':
            return { kind: 'file-contains', path: check.path, text: check.text };
        case 'command-output-contains':
            return {
                kind: 'command-output-contains',
                commandPattern: check.commandPattern,
                text: check.text,
            };
    }
}

/**
 * constraints accept legacy strings (semantic) or structured `{ text, check? }`.
 * Strict but non-fatal: an invalid `check` is dropped while its text is kept as a
 * semantic clause, and a malformed entry is dropped — the block still parses.
 */
function parseConstraints(value: unknown): (string | StructuredConstraint)[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: (string | StructuredConstraint)[] = [];
    for (const item of value) {
        if (typeof item === 'string') {
            if (item.length > 0) out.push(item);
            continue;
        }
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.text !== 'string' || record.text.trim().length === 0) continue;
        const text = record.text.trim();
        out.push(
            isConditionCheck(record.check) ? { text, check: cloneCheck(record.check) } : { text },
        );
    }
    return out.length > 0 ? out : undefined;
}

/** 问题必须同时有 q 与 default（模板硬约束）；形状不全的整条丢弃，不补默认。 */
function parseQuestions(value: unknown): NegotiationQuestion[] {
    if (!Array.isArray(value)) return [];
    const out: NegotiationQuestion[] = [];
    for (const item of value) {
        if (typeof item !== 'object' || item === null) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.q !== 'string' || record.q.length === 0) continue;
        if (typeof record.default !== 'string' || record.default.length === 0) continue;
        out.push({
            q: record.q,
            ...(typeof record.why === 'string' && record.why.length > 0 ? { why: record.why } : {}),
            default: record.default,
        });
        // 模板硬约束：协商最多 2 问（先剔除形状不全的，再截断）
        if (out.length >= 2) break;
    }
    return out;
}

/**
 * 取第一个**平衡的** JSON 对象：真实模型常把 JSON 包在 ```json 代码块或前后解说里，
 * 直接 JSON.parse 会整体失败 → 协商永远不触发。取出后仍走同一套严格形状校验。
 */
function extractJsonObject(raw: string): string | undefined {
    const start = raw.indexOf('{');
    if (start < 0) return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) return raw.slice(start, index + 1);
        }
    }
    return undefined;
}

/** 严格解析 goal-parser 的 JSON 输出；无有效 block 返回 undefined（调用方走 fallback）。 */
export function parseGoalParserOutput(raw: string): ParsedGoalPlan | undefined {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        const extracted = extractJsonObject(raw);
        if (extracted === undefined) return undefined;
        try {
            value = JSON.parse(extracted);
        } catch {
            return undefined;
        }
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const rawBlocks = Array.isArray(record.blocks) ? record.blocks : [];
    const blocks: ParsedBlock[] = [];
    for (const item of rawBlocks) {
        if (typeof item !== 'object' || item === null) continue;
        const block = item as Record<string, unknown>;
        if (typeof block.route !== 'string' || !PARSER_ROUTES.has(block.route)) continue;
        const route = block.route as NegotiationRoute;
        const questions = parseQuestions(block.questions);
        const goals = textList(block.goals);
        const constraints = parseConstraints(block.constraints);
        const understanding = textList(block.understanding);
        const defaultPath = textList(block.defaultPath);
        const conflicts = textList(block.conflicts);
        blocks.push({
            route,
            ...(goals !== undefined ? { goals } : {}),
            ...(constraints !== undefined ? { constraints } : {}),
            ...(understanding !== undefined ? { understanding } : {}),
            ...(defaultPath !== undefined ? { defaultPath } : {}),
            ...(conflicts !== undefined ? { conflicts } : {}),
            ...(typeof block.escalation === 'string' && block.escalation.length > 0
                ? { escalation: block.escalation }
                : {}),
            ...(typeof block.answer === 'string' && block.answer.length > 0
                ? { answer: block.answer }
                : {}),
            ...(questions.length > 0 ? { questions } : {}),
        });
    }
    if (blocks.length === 0) return undefined;
    const trace =
        typeof record.trace === 'object' && record.trace !== null
            ? (record.trace as ParsedGoalPlan['trace'])
            : undefined;
    return { ...(trace !== undefined ? { trace } : {}), blocks };
}

/** 基线机械条款：任何契约都带（deterministicRatio 的起点，评估器能判）。 */
export function baselineConditions(): CheckableCondition[] {
    return [
        {
            id: ulid(),
            checkType: 'deterministic',
            description: '产出最终回答',
            check: { kind: 'final-answer' },
        },
        {
            id: ulid(),
            checkType: 'deterministic',
            description: '执行过程无失败步骤',
            check: { kind: 'no-failed-steps' },
        },
    ];
}

/** 文本 → 语义条款（需 judge；不给它假装机械的 check）。 */
export function semanticConditions(texts: readonly string[]): CheckableCondition[] {
    return texts
        .map((text) => text.trim())
        .filter((text) => text.length > 0)
        .map((text) => ({ id: ulid(), checkType: 'semantic' as const, description: text }));
}

/**
 * triage 条款 → 冻结条款：带合法 check 的结构化 clause 升为 deterministic，
 * 其余（字符串 / 无 check / goals / defaultPath）一律 semantic，不伪造机械判定。
 */
export function conditionsForClauses(
    clauses: readonly (string | StructuredConstraint)[],
): CheckableCondition[] {
    const conditions: CheckableCondition[] = [];
    for (const clause of clauses) {
        if (typeof clause === 'string') {
            conditions.push(...semanticConditions([clause]));
        } else if (clause.check !== undefined) {
            conditions.push({
                id: ulid(),
                checkType: 'deterministic',
                description: clause.text,
                check: clause.check,
            });
        } else {
            conditions.push(...semanticConditions([clause.text]));
        }
    }
    return conditions;
}

function fallbackNegotiation(at: number): GoalNegotiation {
    return {
        route: 'fallback',
        classifiedBy: 'fallback',
        triggers: ['parser-unavailable'],
        questions: [],
        answers: [],
        revision: 0,
        resolved: true,
        at,
    };
}

/** 解析结果 → 协商轨迹 + 冻结条款。negotiate/escalate 默认路径先冻结，答复后修订。 */
export function planNegotiation(
    parsed?: ParsedGoalPlan,
    now: () => number = Date.now,
): NegotiationPlan {
    const at = now();
    const block = parsed?.blocks[0];
    if (parsed === undefined || block === undefined) {
        return { negotiation: fallbackNegotiation(at), conditions: baselineConditions() };
    }
    const route = block.route;
    const clauses: (string | StructuredConstraint)[] =
        route === 'negotiate'
            ? (block.defaultPath ?? [])
            : route === 'direct'
              ? // direct performs no action: baseline clauses only, no target clause
                []
              : [...(block.goals ?? []), ...(block.constraints ?? [])];
    const negotiation: GoalNegotiation = {
        route,
        classifiedBy: 'parser',
        triggers: parsed.trace?.triggers ?? [],
        questions: route === 'negotiate' ? (block.questions ?? []) : [],
        answers: [],
        revision: 0,
        resolved: route === 'confirmed' || route === 'direct',
        at,
        ...(block.understanding !== undefined ? { understanding: block.understanding } : {}),
        ...(block.defaultPath !== undefined ? { defaultPath: block.defaultPath } : {}),
        ...(block.escalation !== undefined ? { escalation: block.escalation } : {}),
        ...(route === 'direct' && block.answer !== undefined ? { directAnswer: block.answer } : {}),
    };
    return {
        negotiation,
        conditions: [...baselineConditions(), ...conditionsForClauses(clauses)],
    };
}

/** 协商答复：只把用户实际写下的答案升格为条款；采纳默认的不新增条款。 */
export function applyNegotiationAnswers(
    current: GoalNegotiation,
    answers: readonly NegotiationAnswer[],
    previousConditions: readonly CheckableCondition[],
    now: () => number = Date.now,
): { negotiation: GoalNegotiation; conditions: CheckableCondition[] } {
    const byQuestion = new Map(current.questions.map((question) => [question.q, question]));
    const merged: NegotiationAnswer[] = answers.map((answer) => {
        const question = byQuestion.get(answer.q);
        const text = answer.answer.trim();
        if (question !== undefined && text.length === 0) {
            return { q: answer.q, answer: question.default, usedDefault: true };
        }
        return { q: answer.q, answer: text, ...(answer.usedDefault ? { usedDefault: true } : {}) };
    });
    const added = semanticConditions(
        merged.filter((answer) => answer.usedDefault !== true).map((answer) => answer.answer),
    );
    return {
        negotiation: {
            ...current,
            answers: merged,
            revision: current.revision + 1,
            resolved: true,
            at: now(),
        },
        conditions: [...previousConditions, ...added],
    };
}
