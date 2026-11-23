import type { UserQuestionView } from '@mazi/libs';
import { buildQuestionView } from '@mazi/libs';
import {
    type QuestionLabelInput,
    type QuestionQuery,
    SqliteQuestionStore,
} from '../memory/question-store.js';
import { type QuestionClassifier, QuestionLabeler } from './labeler.js';
import { loadQuestionTaxonomy, type QuestionTaxonomy } from './taxonomy.js';

/**
 * QuestionService —— 问题存储 + 规则/LLM 标注的组合根。
 *
 * 存储与标注器成对使用，宿主只持有本服务：查询、视图组装、标签追加、
 * 分类器注入与释放都在这里闭环。
 */
export interface QuestionServiceOptions {
    dbPath?: string;
    taxonomyFile?: string;
}

export class QuestionService {
    private readonly store: SqliteQuestionStore;
    private readonly taxonomy: QuestionTaxonomy;
    private readonly labeler: QuestionLabeler;

    constructor(options: QuestionServiceOptions = {}) {
        this.store = new SqliteQuestionStore(options.dbPath ?? ':memory:');
        this.taxonomy = loadQuestionTaxonomy(options.taxonomyFile);
        this.labeler = new QuestionLabeler(this.taxonomy, (questionId, labels) =>
            this.store.addLabels(questionId, labels),
        );
    }

    taxonomyView(): QuestionTaxonomy {
        return this.taxonomy;
    }

    setClassifier(classifier: QuestionClassifier): void {
        this.labeler.setClassifier(classifier);
    }

    label(questionId: string, text: string): Promise<void> {
        return this.labeler.label(questionId, text);
    }

    async classify(questionId: string): Promise<boolean> {
        const record = await this.store.get(questionId);
        if (record === undefined) return false;
        await this.labeler.classify(questionId, record.text);
        return true;
    }

    async list(query: QuestionQuery = {}): Promise<UserQuestionView[]> {
        const records = await this.store.list(query);
        const labels = await this.store.listLabelsFor(records.map((record) => record.questionId));
        return records.map((record) =>
            buildQuestionView(record, labels.get(record.questionId) ?? []),
        );
    }

    async view(questionId: string): Promise<UserQuestionView | undefined> {
        const record = await this.store.get(questionId);
        if (record === undefined) return undefined;
        return buildQuestionView(record, await this.store.listLabels(questionId));
    }

    addLabels(questionId: string, labels: readonly QuestionLabelInput[]): Promise<void> {
        return this.store.addLabels(questionId, labels);
    }

    close(): void {
        this.store.close();
    }
}
