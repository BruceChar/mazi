/**
 * Three-question risk model (V3 §5).
 *
 * Q1: is the consequence irreversible at the current point in time?
 * Q2: does the operation put content into the model context?
 * Q3: does the operation modify the permission envelope itself?
 *
 * The declaration (ToolSemantics) answers the questions structurally; the value
 * layer re-answers Q1/Q3 against the concrete target and may only tighten.
 */

import type { ResolvedLabel } from './labels.js';
import {
    type EffectTier,
    type QuestionHit,
    strictestTier,
    type ToolSemantics,
    type ValueProjection,
} from './types.js';

/** Q1 value-layer recognition of an irreversible verb. */
export interface VerbMatch {
    verb: string;
    reason: string;
}

interface VerbPattern {
    verb: string;
    pattern: RegExp;
    reason: string;
}

const VERB_PATTERNS: readonly VerbPattern[] = [
    { verb: 'rm', pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)*/i, reason: 'rm 删除不可撤回' },
    { verb: 'shred', pattern: /\bshred\b/i, reason: 'shred 覆写删除不可撤回' },
    { verb: 'dd', pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'dd 写块设备不可撤回' },
    {
        verb: 'drop',
        pattern: /\b(?:DROP|TRUNCATE)\s+(?:TABLE|DATABASE|SCHEMA)\b/i,
        reason: 'DDL 不可撤回',
    },
    {
        verb: 'delete-no-where',
        pattern: /\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)/i,
        reason: 'DELETE 无 WHERE 不可撤回',
    },
    {
        verb: 'git-push-force',
        pattern: /\bgit\s+push\b[^\n]*--force\b/i,
        reason: 'git push --force 覆写远端历史',
    },
];

export function matchDangerVerb(command?: string, sql?: string): VerbMatch[] {
    const text = sql ? `${command ?? ''}\n${sql}` : (command ?? '');
    if (text.length === 0) return [];
    return VERB_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => ({
        verb: p.verb,
        reason: p.reason,
    }));
}

const WRITE_ACTIONS = new Set(['delete', 'db.write', 'db.schema', 'publish', 'pay']);

/** True when the capability mutates a target asset. */
export function isWriteCapability(capability: string): boolean {
    if (WRITE_ACTIONS.has(capability)) return true;
    return capability.includes('write');
}

export interface QuestionInput {
    capability: string;
    semantics: ToolSemantics;
    projection: ValueProjection;
    target: ResolvedLabel;
}

export interface QuestionAssessment {
    questions: QuestionHit[];
    /** lower bound contributed by Q1/Q3 (never takes part in the meet). */
    floor: EffectTier;
    /** hard clamp: secret write is forbidden (floor 1). */
    hard: EffectTier;
    hardReason?: string;
}

export function assessQuestions(input: QuestionInput): QuestionAssessment {
    const { capability, semantics, projection, target } = input;
    const questions: QuestionHit[] = [];
    let floor: EffectTier = 'auto';
    let hard: EffectTier = 'auto';
    let hardReason: string | undefined;

    const verbs = matchDangerVerb(projection.command, projection.sql);
    if (semantics.irreversible === true || verbs.length > 0) {
        floor = strictestTier(floor, 'gated');
        const reason =
            verbs.length > 0
                ? `Q1 不可撤回：${verbs.map((v) => v.verb).join(',')}`
                : 'Q1 不可撤回：工具声明';
        questions.push({ question: 'Q1', capability, reason });
    }

    if (semantics.ingest === true) {
        questions.push({ question: 'Q2', capability, reason: 'Q2 内容置入模型上下文' });
    }

    const boundaryWrite = target.boundary && isWriteCapability(capability);
    if (semantics.envelope === true || boundaryWrite) {
        floor = strictestTier(floor, 'gated');
        questions.push({
            question: 'Q3',
            capability,
            reason: boundaryWrite ? 'Q3 修改权限包络（边界集）' : 'Q3 修改权限包络：工具声明',
        });
    }

    if (target.label === 'secret' && isWriteCapability(capability)) {
        hard = 'forbidden';
        hardReason = '底线 1：秘密级写入禁止';
    }

    return { questions, floor, hard, ...(hardReason ? { hardReason } : {}) };
}
