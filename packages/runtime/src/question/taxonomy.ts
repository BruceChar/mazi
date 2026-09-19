/**
 * question/taxonomy —— 问题标签分类法注册表（默认 + 可覆盖 + 校验）。
 *
 * 见 docs/用户问题标签与分类设计.md §5：闭集轴（言说类型/主域/子类）+ 开放话题；
 * 数据驱动、版本化，模式对齐 auth commands.json。
 */

import { existsSync, readFileSync } from 'node:fs';
import type { LabelAxis, QuestionLabelInput } from '@mazi/libs';

export interface QuestionTaxonomy {
    version: number;
    /** 言说类型闭集。 */
    speechAct: string[];
    /** 主域 → 子类。 */
    domains: Record<string, string[]>;
    /** 话题别名归一（原始 → 规范）。 */
    aliases: Record<string, string>;
    /** 规则主域关键词（命中即打该主域；用于无 LLM 的确定性预标注）。 */
    domainKeywords: Record<string, string[]>;
    /** 规则话题关键词（原文包含 → 规范话题）。 */
    topicKeywords: Record<string, string>;
}

export const QUESTION_TAXONOMY_VERSION = 1;

export const DEFAULT_QUESTION_TAXONOMY: QuestionTaxonomy = {
    version: QUESTION_TAXONOMY_VERSION,
    speechAct: ['task', 'question', 'statement', 'feedback', 'decision', 'meta', 'chitchat'],
    domains: {
        personal: ['health', 'finance', 'relationship', 'family', 'lifestyle', 'habit'],
        growth: ['mindset', 'learning', 'skill', 'career-plan'],
        emotion: ['mood', 'anxiety', 'conflict', 'motivation', 'self-esteem'],
        professional: ['engineering', 'management', 'product', 'design', 'research', 'operations'],
        knowledge: ['technology', 'science', 'humanities', 'law', 'medicine', 'education'],
        system: ['agent', 'workflow', 'settings', 'data'],
    },
    aliases: { ts: 'typescript', js: 'javascript', nodejs: 'node', vuejs: 'vue' },
    domainKeywords: {
        professional: [
            '代码',
            '工程',
            '架构',
            '重构',
            'bug',
            '接口',
            'api',
            '部署',
            '项目',
            '需求',
            '产品',
            '管理',
            '设计',
            '研究',
            '运营',
            'code',
            'refactor',
        ],
        growth: ['成长', '规划', '职业', '学习', '技能', '习惯', '心态', 'career', 'learning'],
        emotion: ['情感', '情绪', '焦虑', '难过', '开心', '孤独', '冲突', '关系', 'motivation'],
        personal: ['健康', '睡眠', '饮食', '财务', '理财', '家庭', '生活', 'health', 'finance'],
        knowledge: ['历史', '物理', '数学', '法律', '医学', '哲学', '科学', '知识', 'science'],
        system: ['你是什么', '模型', '系统', '设置', '配置', '工作流', 'agent', 'mazi'],
    },
    topicKeywords: {
        typescript: 'typescript',
        javascript: 'javascript',
        vue: 'vue',
        react: 'react',
        node: 'node',
        sqlite: 'sqlite',
        sql: 'sql',
        python: 'python',
        rust: 'rust',
        docker: 'docker',
        git: 'git',
        职业规划: 'career',
        理财: 'finance',
        睡眠: 'sleep',
        焦虑: 'anxiety',
    },
};

/** 读取用户覆盖的注册表（存在则合并；损坏则回落默认并忽略覆盖）。 */
export function loadQuestionTaxonomy(filePath?: string): QuestionTaxonomy {
    if (filePath === undefined || !existsSync(filePath)) return DEFAULT_QUESTION_TAXONOMY;
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<QuestionTaxonomy>;
        return {
            version: parsed.version ?? DEFAULT_QUESTION_TAXONOMY.version,
            speechAct: parsed.speechAct ?? DEFAULT_QUESTION_TAXONOMY.speechAct,
            domains: { ...DEFAULT_QUESTION_TAXONOMY.domains, ...(parsed.domains ?? {}) },
            aliases: { ...DEFAULT_QUESTION_TAXONOMY.aliases, ...(parsed.aliases ?? {}) },
            domainKeywords: {
                ...DEFAULT_QUESTION_TAXONOMY.domainKeywords,
                ...(parsed.domainKeywords ?? {}),
            },
            topicKeywords: {
                ...DEFAULT_QUESTION_TAXONOMY.topicKeywords,
                ...(parsed.topicKeywords ?? {}),
            },
        };
    } catch {
        return DEFAULT_QUESTION_TAXONOMY;
    }
}

/** 机械校验：丢弃不在注册表内的标签（LLM 输出不可信，宁缺毋滥）。 */
export function filterTaxonomyLabels(
    taxonomy: QuestionTaxonomy,
    labels: readonly QuestionLabelInput[],
): { kept: QuestionLabelInput[]; dropped: QuestionLabelInput[] } {
    const kept: QuestionLabelInput[] = [];
    const dropped: QuestionLabelInput[] = [];
    const allCategories = new Set(Object.values(taxonomy.domains).flat());
    for (const label of labels) {
        const ok = accepts(taxonomy, allCategories, label);
        (ok ? kept : dropped).push(label);
    }
    return { kept, dropped };
}

function accepts(
    taxonomy: QuestionTaxonomy,
    allCategories: ReadonlySet<string>,
    label: QuestionLabelInput,
): boolean {
    if (label.axis === 'speech_act') return taxonomy.speechAct.includes(label.label);
    if (label.axis === 'domain') return Object.hasOwn(taxonomy.domains, label.label);
    if (label.axis === 'category') return allCategories.has(label.label);
    // topic 开放；sentiment/urgency/sensitivity 为属性闭集（暂不校验）。
    return true;
}

/** 轴常量（供 api/webui 校验请求体复用）。 */
export const KNOWN_AXES: readonly LabelAxis[] = [
    'speech_act',
    'domain',
    'category',
    'topic',
    'sentiment',
    'urgency',
    'sensitivity',
];
