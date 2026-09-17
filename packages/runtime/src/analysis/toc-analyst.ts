/**
 * toc-analyst —— TOC 的独立分析编排。
 *
 * 冻结当前 Task 的 thinking 链（renderThinkingChain）为 toc 记录，然后以**独立 provider 调用**
 * （不进 Goal/Task/Step 坐标系）跑一次分析 Agent，输出与反馈各自落库。
 */

import { ulid } from '@mazi/core';
import type {
    GoalTreeSnapshot,
    TocAnalysisView,
    TocFeedbackView,
    TocIterationView,
    TocRecordView,
} from '@mazi/libs';
import { renderThinkingChain } from '@mazi/libs';
import type { ExecutorRoundContext, RoundResult } from '../gts/round-types.js';
import { TOC_ANALYZE_PROMPT } from '../templates/prompts/toc-analyze.prompt.js';
import { buildIterations, type TocAnalysisRecord, type TocStore } from './toc-store.js';

export interface TocModelRef {
    providerId: string;
    modelId: string;
}

export interface TocAnalystDeps {
    store: TocStore;
    /** 取某棵 Goal 树的投影快照（用于冻结 thinking 链）。 */
    snapshotOf: (rootGoalId: string) => Promise<GoalTreeSnapshot>;
    /** 独立 provider 调用（RoundRunner.requestRound 的形状；goalId/taskId 留空）。 */
    requestRound: (
        rootGoalId: string,
        ctx: ExecutorRoundContext,
        reasoningLevel?: string,
    ) => Promise<RoundResult>;
    /** 解析模型选择（缺省用运行时默认）。 */
    resolveModelChoice: (modelId?: string) => TocModelRef | undefined;
    now?: () => number;
}

export interface AnalyzeTocInput {
    taskId: string;
    goalId: string;
    rootGoalId: string;
    /** 分析诉求（用户输入）。 */
    userInput: string;
    modelId?: string;
    /** 复用已有 toc（对同一快照再次分析）；缺省则冻结当前 thinking 链。 */
    tocId?: string;
}

function buildAnalyzePrompt(toc: TocRecordView, userInput: string): string {
    const sections = [
        `# Task input\n${toc.userInput.trim() || '(none)'}`,
        `# Thinking chain (TOC, frozen)\n${toc.text.trim() || '(empty)'}`,
        `# Analysis request\n${
            userInput.trim() ||
            'Audit this thinking chain for defects and propose concrete improvements.'
        }`,
    ];
    return sections.join('\n\n');
}

export class TocAnalyst {
    private readonly store: TocStore;
    private readonly snapshotOf: TocAnalystDeps['snapshotOf'];
    private readonly requestRound: TocAnalystDeps['requestRound'];
    private readonly resolveModelChoice: TocAnalystDeps['resolveModelChoice'];
    private readonly now: () => number;

    constructor(deps: TocAnalystDeps) {
        this.store = deps.store;
        this.snapshotOf = deps.snapshotOf;
        this.requestRound = deps.requestRound;
        this.resolveModelChoice = deps.resolveModelChoice;
        this.now = deps.now ?? Date.now;
    }

    /** 冻结/复用 toc，并在其上跑一次独立分析；返回 toc 与该次分析。 */
    async analyze(
        input: AnalyzeTocInput,
    ): Promise<{ toc: TocRecordView; analysis: TocAnalysisView }> {
        const toc = await this.resolveToc(input);
        const model = this.resolveModelChoice(input.modelId) ?? toc.model;
        const analysis: TocAnalysisRecord = {
            analyzeId: ulid(),
            tocId: toc.tocId,
            userInput: input.userInput,
            ...(model ? { model } : {}),
            status: 'running',
            output: '',
            createdAt: this.now(),
        };
        await this.store.saveAnalysis(analysis);
        try {
            const result = await this.requestRound(`analysis-${analysis.analyzeId}`, {
                model: model ?? { providerId: 'default', modelId: 'default' },
                messages: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: buildAnalyzePrompt(toc, input.userInput) }],
                    },
                ],
                systemPrompt: TOC_ANALYZE_PROMPT,
                tools: [],
                baseMessageCount: 0,
            });
            analysis.output = result.text;
            analysis.status = 'succeeded';
        } catch (error) {
            analysis.status = 'failed';
            analysis.error = error instanceof Error ? error.message : String(error);
        }
        analysis.endedAt = this.now();
        await this.store.saveAnalysis(analysis);
        return { toc, analysis: { ...analysis, feedback: [] } };
    }

    async listIterations(): Promise<TocIterationView[]> {
        const [tocs, analyses, feedback] = await Promise.all([
            this.store.listTocs(),
            this.store.listAnalyses(),
            this.store.listFeedback(),
        ]);
        return buildIterations(tocs, analyses, feedback);
    }

    async addFeedback(
        analyzeId: string,
        input: { content: string; rating?: number },
    ): Promise<TocFeedbackView> {
        const analysis = await this.store.loadAnalysis(analyzeId);
        if (!analysis) {
            throw new Error(`analysis not found: ${analyzeId}`);
        }
        const feedback: TocFeedbackView = {
            feedbackId: ulid(),
            analyzeId,
            content: input.content,
            ...(input.rating !== undefined ? { rating: input.rating } : {}),
            createdAt: this.now(),
        };
        await this.store.saveFeedback(feedback);
        return feedback;
    }

    private async resolveToc(input: AnalyzeTocInput): Promise<TocRecordView> {
        if (input.tocId) {
            const existing = await this.store.loadToc(input.tocId);
            if (existing) return existing;
        }
        const snapshot = await this.snapshotOf(input.rootGoalId);
        const task = snapshot.goals
            .flatMap((goal) => goal.tasks)
            .find((candidate) => candidate.taskId === input.taskId);
        if (!task) {
            throw new Error(`task not found: ${input.taskId}`);
        }
        const model = this.resolveModelChoice(input.modelId);
        const toc: TocRecordView = {
            tocId: ulid(),
            taskId: input.taskId,
            goalId: input.goalId || task.taskId,
            rootGoalId: input.rootGoalId,
            userInput: input.userInput,
            ...(model ? { model } : {}),
            text: renderThinkingChain(task.steps),
            createdAt: this.now(),
        };
        await this.store.saveToc(toc);
        return toc;
    }
}
