/**
 * question-taxonomy —— 用户问题的标签轴、线协议视图与有效标签合并（api/webui 共享，纯函数）。
 *
 * 存储与标注见 docs/用户问题标签与分类设计.md：闭集轴（言说类型/主域/子类…）+ 开放话题；
 * 标签带来源（rule/llm/user），更正 append-only。本模块只做「行 → 有效标签」的确定性合并。
 */

/** 标签轴：闭集轴 + 开放话题 + 可选属性。 */
export type LabelAxis =
    | 'speech_act'
    | 'domain'
    | 'category'
    | 'topic'
    | 'sentiment'
    | 'urgency'
    | 'sensitivity';

export type QuestionLabelSource = 'rule' | 'llm' | 'user';

/** 一条标签（append-only；来源与版本随行）。 */
export interface QuestionLabelView {
    axis: LabelAxis;
    label: string;
    source: QuestionLabelSource;
    confidence?: number;
    taxonomyVersion?: number;
    model?: string;
}

/** 待写入的一条标签（append-only；与 QuestionLabelView 同形，语义为输入）。 */
export interface QuestionLabelInput {
    axis: LabelAxis;
    label: string;
    source: QuestionLabelSource;
    confidence?: number;
    taxonomyVersion?: number;
    model?: string;
}

/** 问题标签分类法注册表（GET /api/question-taxonomy 线协议）。 */
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

/** 单标签轴（每轴取一条）；其余为多标签轴。 */
export const SINGLE_LABEL_AXES: readonly LabelAxis[] = [
    'speech_act',
    'domain',
    'sentiment',
    'urgency',
    'sensitivity',
];

/** 问题实体（存储 + 查询的基础形态）。 */
export interface UserQuestionRecord {
    questionId: string;
    ts: number;
    text: string;
    derived: boolean;
    sessionId: string;
    userId?: string;
    conversationId?: string;
    createdAt: number;
}

/** 有效标签：轴 → 归一后的标签列表（单标签轴最多 1 条）。 */
export type EffectiveLabels = Partial<Record<LabelAxis, string[]>>;

/** 问题视图（API/UI 线协议）。 */
export interface UserQuestionView extends UserQuestionRecord {
    labels: QuestionLabelView[];
    effective: EffectiveLabels;
}

const SOURCE_RANK: Record<QuestionLabelSource, number> = { user: 2, llm: 1, rule: 0 };

function isSingleAxis(axis: LabelAxis): boolean {
    return SINGLE_LABEL_AXES.includes(axis);
}

/**
 * 有效标签合并：
 * - 单标签轴：取来源优先级最高（user > llm > rule）的一条；
 * - 多标签轴：存在 user 行时只取 user（用户覆盖整轴），否则 rule ∪ llm，去重排序。
 */
export function effectiveLabels(labels: readonly QuestionLabelView[]): EffectiveLabels {
    const result: EffectiveLabels = {};
    const axes = [...new Set(labels.map((row) => row.axis))];
    for (const axis of axes) {
        const rows = labels.filter((row) => row.axis === axis);
        if (isSingleAxis(axis)) {
            const top = [...rows].sort(
                (a, b) =>
                    SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || a.label.localeCompare(b.label),
            )[0];
            if (top !== undefined) result[axis] = [top.label];
            continue;
        }
        const userRows = rows.filter((row) => row.source === 'user');
        const chosen = userRows.length > 0 ? userRows : rows;
        result[axis] = [...new Set(chosen.map((row) => row.label))].sort();
    }
    return result;
}

/** 问题记录 + 标签行 → 视图（有效标签确定性合并）。 */
export function buildQuestionView(
    question: UserQuestionRecord,
    labels: readonly QuestionLabelView[],
): UserQuestionView {
    return { ...question, labels: [...labels], effective: effectiveLabels(labels) };
}
