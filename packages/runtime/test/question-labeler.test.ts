import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';
import { ruleQuestionLabels, ruleSpeechAct } from '../src/question/labeler.js';
import {
    DEFAULT_QUESTION_TAXONOMY,
    filterTaxonomyLabels,
    loadQuestionTaxonomy,
} from '../src/question/taxonomy.js';

const dirs: string[] = [];
function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-label-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: join(dir, 'mazi.db'),
        eventDir: dir,
        goal: { allowedTools: [], permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

describe('问题标签：规则与注册表（QQ-D）', () => {
    it('ruleSpeechAct：任务/问题/反馈/决策/元/闲聊 判据', () => {
        expect(ruleSpeechAct('帮我改一下这个文件的类型')).toBe('task');
        expect(ruleSpeechAct('这个设计有什么根本问题？')).toBe('question');
        expect(ruleSpeechAct('太啰嗦了，直接说结论')).toBe('feedback');
        expect(ruleSpeechAct('用方案 B')).toBe('decision');
        expect(ruleSpeechAct('你是什么模型？')).toBe('meta');
        expect(ruleSpeechAct('你好')).toBe('chitchat');
        expect(ruleSpeechAct('我用的是 Node 24')).toBe('statement');
    });

    it('ruleQuestionLabels：speech_act + domain + topic（命中才打，不臆造）', () => {
        const labels = ruleQuestionLabels('我最近很焦虑，怎么办？', DEFAULT_QUESTION_TAXONOMY);
        expect(labels).toContainEqual({ axis: 'speech_act', label: 'question', source: 'rule' });
        expect(labels).toContainEqual({ axis: 'domain', label: 'emotion', source: 'rule' });
        expect(labels).toContainEqual({ axis: 'topic', label: 'anxiety', source: 'rule' });

        const none = ruleQuestionLabels('嗯', DEFAULT_QUESTION_TAXONOMY);
        expect(none).toEqual([{ axis: 'speech_act', label: 'statement', source: 'rule' }]);
    });

    it('filterTaxonomyLabels：丢弃不在注册表内的标签', () => {
        const { kept, dropped } = filterTaxonomyLabels(DEFAULT_QUESTION_TAXONOMY, [
            { axis: 'domain', label: 'growth', source: 'llm' },
            { axis: 'domain', label: 'bogus', source: 'llm' },
            { axis: 'category', label: 'career-plan', source: 'llm' },
            { axis: 'category', label: 'bogus', source: 'llm' },
            { axis: 'topic', label: 'anything-goes', source: 'llm' },
        ]);
        expect(kept.map((l) => l.label)).toEqual(['growth', 'career-plan', 'anything-goes']);
        expect(dropped.map((l) => l.label)).toEqual(['bogus', 'bogus']);
    });

    it('loadQuestionTaxonomy：用户覆盖合并默认', () => {
        const dir = tmpDir();
        const file = join(dir, 'taxonomy.json');
        writeFileSync(
            file,
            JSON.stringify({ version: 2, domains: { custom: ['x'] }, aliases: { foo: 'bar' } }),
        );
        const taxonomy = loadQuestionTaxonomy(file);
        expect(taxonomy.version).toBe(2);
        expect(taxonomy.domains.custom).toEqual(['x']);
        expect(taxonomy.domains.personal).toBeDefined();
        expect(taxonomy.aliases).toMatchObject({ foo: 'bar', nodejs: 'node' });
    });

    it('runtime：输入即规则标注；注入分类器后精标（经注册表校验）', async () => {
        const dir = tmpDir();
        const runtime = new HarnessRuntime(configIn(dir));
        runtime.setQuestionClassifier(async () => [
            { axis: 'domain', label: 'growth', source: 'llm', confidence: 0.9 },
            { axis: 'category', label: 'career-plan', source: 'llm', confidence: 0.8 },
            { axis: 'category', label: 'not-real', source: 'llm' },
        ]);
        try {
            await runtime.createGoalSession('我该怎么规划职业？', { userId: 'me' });
            await new Promise((resolve) => setTimeout(resolve, 30));
            const question = (await runtime.listQuestions({}))[0];
            expect(question?.effective.speech_act).toEqual(['question']);
            expect(question?.effective.domain).toEqual(['growth']);
            expect(question?.effective.category).toEqual(['career-plan']);
            expect(
                question?.labels.some((row) => row.source === 'llm' && row.label === 'career-plan'),
            ).toBe(true);
            expect(question?.labels.some((row) => row.label === 'not-real')).toBe(false);
        } finally {
            await runtime.close();
        }
    });

    it('runtime：历史回填输入也规则标注', async () => {
        const dir = tmpDir();
        const runtime = new HarnessRuntime(configIn(dir));
        try {
            const created = await runtime.createGoalSession('新问题');
            await runtime.clearBehaviors(created.rootGoalId);
            await runtime.backfillBehaviorInput(created.rootGoalId, {
                input: '帮我重构这段代码',
                createdAt: 1000,
            });
            const question = (await runtime.listQuestions({}))[0];
            expect(question?.text).toBe('帮我重构这段代码');
            expect(question?.effective.speech_act).toEqual(['task']);
            expect(question?.effective.domain).toEqual(['professional']);
        } finally {
            await runtime.close();
        }
    });
});
