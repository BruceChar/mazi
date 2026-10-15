/**
 * capabilities/intent.ts —— 意图路由打分（docs/能力包规范.md §7.3）。
 *
 * 确定性打分，不调用 LLM：domain/category 命中优先（各 +2），关键词兜底（每个 +1，上限 +2）；
 * 非 task/question 的言说类型不参与路由。并列命中由调用方询问用户（resolveByIntent 只返回
 * 唯一最高者，见 registry）。
 */

import type { SkillId, SkillManifest } from '@mazi/core';

export interface SkillIntentQuery {
    speechAct?: string;
    domains?: readonly string[];
    categories?: readonly string[];
    keywords?: readonly string[];
    /** 原文（可选）：用于关键词兜底命中。 */
    text?: string;
}

export interface SkillIntentMatch {
    skillId: SkillId;
    /** 0-1 确定性口径：命中项加权后归一到「domain + category」满分 4 分制。 */
    confidence: number;
    reasons: readonly string[];
}

const ROUTABLE_SPEECH_ACTS: ReadonlySet<string> = new Set(['task', 'question']);
const DOMAIN_WEIGHT = 2;
const CATEGORY_WEIGHT = 2;
const KEYWORD_WEIGHT = 1;
const KEYWORD_WEIGHT_CAP = 2;
const MAX_SCORE = DOMAIN_WEIGHT + CATEGORY_WEIGHT;

function intersect(declared: readonly string[], query: readonly string[] | undefined): string[] {
    if (query === undefined || query.length === 0) return [];
    const wanted = new Set(query);
    return declared.filter((item) => wanted.has(item));
}

function textContains(keyword: string, text: string): boolean {
    return text.toLowerCase().includes(keyword.toLowerCase());
}

/** 单个能力包的意图得分；0 分（或不可路由的言说类型）返回 undefined。 */
export function scoreSkillIntent(
    manifest: SkillManifest,
    query: SkillIntentQuery,
): SkillIntentMatch | undefined {
    if (query.speechAct !== undefined && !ROUTABLE_SPEECH_ACTS.has(query.speechAct))
        return undefined;
    const reasons: string[] = [];
    let score = 0;
    const domains = intersect(manifest.intents.domains, query.domains);
    if (domains.length > 0) {
        score += DOMAIN_WEIGHT;
        reasons.push('domain:' + domains.join(','));
    }
    const categories = intersect(manifest.intents.categories, query.categories);
    if (categories.length > 0) {
        score += CATEGORY_WEIGHT;
        reasons.push('category:' + categories.join(','));
    }
    const keywordHits = new Set(intersect(manifest.intents.keywords, query.keywords));
    if (query.text !== undefined && query.text.length > 0) {
        for (const keyword of manifest.intents.keywords) {
            if (textContains(keyword, query.text)) keywordHits.add(keyword);
        }
    }
    if (keywordHits.size > 0) {
        score += Math.min(keywordHits.size, KEYWORD_WEIGHT_CAP) * KEYWORD_WEIGHT;
        reasons.push('keyword:' + [...keywordHits].join(','));
    }
    if (score === 0) return undefined;
    return {
        skillId: manifest.id,
        confidence: Math.min(1, score / MAX_SCORE),
        reasons,
    };
}
