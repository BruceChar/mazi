/**
 * question/labeler —— 问题标注：规则预标注（同步）+ LLM 精标（seam，可选、异步）。
 *
 * 规则产出 speech_act / domain / topic（确定性、零成本）；LLM 分类器通过
 * setQuestionClassifier 注入，输出经注册表机械校验后才落库（见设计文档 §6）。
 */

import type { QuestionLabelInput } from '@mazi/libs';
import { filterTaxonomyLabels, type QuestionTaxonomy } from './taxonomy.js';

/** LLM 分类器：文本 + 注册表 → 候选标签（未经校验）。 */
export type QuestionClassifier = (
    text: string,
    taxonomy: QuestionTaxonomy,
) => Promise<QuestionLabelInput[]>;

const QUESTION_MARKS = /[?？]|吗|什么|怎么|为什么|如何|哪|谁|多少|是不是/;
const TASK_VERBS = /帮|请|改|写|跑|执行|修|加|删|生成|创建|优化|实现|整理|重构|部署/;
const FEEDBACK_HINTS = /太|别|不要|很好|不错|不行|啰嗦|错了|不对|可以了|满意/;
const DECISION_HINTS = /允许|批准|同意|用方案|就这个|就这么|可以执行|授权/;
const META_HINTS = /你是什么|你是谁|什么模型|系统|设置|工作流|mazi|agent/;
const CHITCHAT_HINTS = /^(在吗|你好|您好|hi|hello|嗨|在不在)[!！。~\s]*$/i;

/** 规则判定言说类型（优先级：闲聊 > 元 > 反馈 > 决策 > 任务 > 问题 > 陈述）。 */
export function ruleSpeechAct(text: string): string {
    const value = text.trim();
    if (CHITCHAT_HINTS.test(value)) return 'chitchat';
    if (META_HINTS.test(value)) return 'meta';
    if (FEEDBACK_HINTS.test(value) && !QUESTION_MARKS.test(value)) return 'feedback';
    if (DECISION_HINTS.test(value)) return 'decision';
    if (TASK_VERBS.test(value) && !QUESTION_MARKS.test(value)) return 'task';
    if (QUESTION_MARKS.test(value)) return 'question';
    return 'statement';
}

/**
 * 规则预标注：speech_act（单）+ domain（首个命中关键词）+ topic（关键词/别名命中）。
 * 不产出 category（属 LLM 精标）；无命中则留空，不强行归 other。
 */
export function ruleQuestionLabels(text: string, taxonomy: QuestionTaxonomy): QuestionLabelInput[] {
    const labels: QuestionLabelInput[] = [
        { axis: 'speech_act', label: ruleSpeechAct(text), source: 'rule' },
    ];
    const lower = text.toLowerCase();
    const domain = Object.keys(taxonomy.domainKeywords).find((candidate) =>
        taxonomy.domainKeywords[candidate]?.some(
            (keyword) => text.includes(keyword) || lower.includes(keyword.toLowerCase()),
        ),
    );
    if (domain !== undefined) {
        labels.push({ axis: 'domain', label: domain, source: 'rule' });
    }
    const topics = new Set<string>();
    for (const [keyword, canonical] of Object.entries(taxonomy.topicKeywords)) {
        if (text.includes(keyword) || lower.includes(keyword.toLowerCase())) topics.add(canonical);
    }
    for (const topic of topics) {
        labels.push({ axis: 'topic', label: topic, source: 'rule' });
    }
    return labels;
}

/** 问题标注器：规则同步落库；LLM 分类器存在时异步精标（校验后落库，失败留日志）。 */
export class QuestionLabeler {
    private readonly taxonomy: QuestionTaxonomy;
    private readonly addLabels: (
        questionId: string,
        labels: readonly QuestionLabelInput[],
    ) => Promise<void>;
    private classifier?: QuestionClassifier;

    constructor(
        taxonomy: QuestionTaxonomy,
        addLabels: (questionId: string, labels: readonly QuestionLabelInput[]) => Promise<void>,
    ) {
        this.taxonomy = taxonomy;
        this.addLabels = addLabels;
    }

    setClassifier(classifier: QuestionClassifier): void {
        this.classifier = classifier;
    }

    /** 规则预标注（同步、可 await）。 */
    async labelRules(questionId: string, text: string): Promise<void> {
        const labels = ruleQuestionLabels(text, this.taxonomy);
        if (labels.length > 0) await this.addLabels(questionId, labels);
    }

    /** LLM 精标（异步；需已注入分类器）。 */
    async classify(questionId: string, text: string): Promise<void> {
        if (this.classifier === undefined) return;
        const raw = await this.classifier(text, this.taxonomy);
        const { kept, dropped } = filterTaxonomyLabels(this.taxonomy, raw);
        if (kept.length > 0) await this.addLabels(questionId, kept);
        if (dropped.length > 0) {
            process.stderr.write(
                `question classifier: dropped ${dropped.length} out-of-taxonomy labels\n`,
            );
        }
    }

    /** 规则落库 + 后台精标（不阻断主流程）。 */
    async label(questionId: string, text: string): Promise<void> {
        await this.labelRules(questionId, text);
        if (this.classifier !== undefined) {
            void this.classify(questionId, text).catch((error: unknown) => {
                process.stderr.write(`question classify error: ${String(error)}\n`);
            });
        }
    }
}
