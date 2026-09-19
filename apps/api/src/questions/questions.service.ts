import 'reflect-metadata';
import type { LabelAxis, UserQuestionView } from '@mazi/libs';
import { filterTaxonomyLabels, KNOWN_AXES } from '@mazi/runtime';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** 问题详情、用户标签覆盖、重标与分类法（GET/POST /api/questions*）。 */
@Injectable()
export class QuestionsService {
    constructor(private readonly runtime: ApiRuntimeService) {}

    async get(questionId: string): Promise<UserQuestionView> {
        const view = await this.runtime.harness().getQuestion(questionId);
        if (view === undefined) throw new ApiError(404, 'question not found');
        return view;
    }

    /** 用户覆盖标签（append-only；source 固定 user，经注册表校验后落库）。 */
    async addLabels(questionId: string, body: { labels?: unknown }): Promise<UserQuestionView> {
        const runtime = this.runtime.harness();
        if ((await runtime.getQuestion(questionId)) === undefined) {
            throw new ApiError(404, 'question not found');
        }
        const labels = parseUserLabels(body?.labels).map((label) => ({
            ...label,
            source: 'user' as const,
        }));
        const { dropped } = filterTaxonomyLabels(runtime.getQuestionTaxonomy(), labels);
        if (dropped.length > 0) {
            throw new ApiError(
                400,
                `标签不在分类法内：${dropped.map((row) => `${row.axis}:${row.label}`).join(', ')}`,
            );
        }
        await runtime.addQuestionLabels(questionId, labels);
        return (await runtime.getQuestion(questionId)) as UserQuestionView;
    }

    /** 重跑 LLM 精标（需运行时已注入分类器；未注入则仅返回当前视图）。 */
    async classify(questionId: string): Promise<UserQuestionView> {
        const runtime = this.runtime.harness();
        if (!(await runtime.classifyQuestion(questionId))) {
            throw new ApiError(404, 'question not found');
        }
        return (await runtime.getQuestion(questionId)) as UserQuestionView;
    }

    taxonomy() {
        return this.runtime.harness().getQuestionTaxonomy();
    }
}

function parseUserLabels(raw: unknown): Array<{ axis: LabelAxis; label: string }> {
    if (!Array.isArray(raw) || raw.length === 0) throw new ApiError(400, 'labels 必须是非空数组');
    return raw.map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const axis = typeof row.axis === 'string' ? row.axis : '';
        const label = typeof row.label === 'string' ? row.label.trim() : '';
        if (!(KNOWN_AXES as readonly string[]).includes(axis)) {
            throw new ApiError(400, `axis 非法：${axis}`);
        }
        if (label.length === 0) throw new ApiError(400, 'label 不能为空');
        return { axis: axis as LabelAxis, label };
    });
}
