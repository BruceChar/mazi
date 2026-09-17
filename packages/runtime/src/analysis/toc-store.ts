/**
 * toc-store —— TOC / Analyze / Feedback 的独立存储（同 goal_nodes 模式：node:sqlite + JSON 列）。
 *
 * 三张表：toc_records（冻结 thinking 链）、toc_analyses（toc 1..N analyze）、
 * toc_feedback（analyze 1..N feedback）。视图装配走纯函数 buildIterations（零 mock 可测）。
 */

import { DatabaseSync } from 'node:sqlite';
import type { TocAnalysisView, TocFeedbackView, TocIterationView, TocRecordView } from '@mazi/libs';

/** 存储态分析记录（feedback 单独成表，不内嵌）。 */
export type TocAnalysisRecord = Omit<TocAnalysisView, 'feedback'>;
export type TocRecord = TocRecordView;
export type TocFeedbackRecord = TocFeedbackView;

export interface TocStore {
    saveToc(record: TocRecord): Promise<void>;
    loadToc(tocId: string): Promise<TocRecord | undefined>;
    listTocs(): Promise<TocRecord[]>;
    saveAnalysis(record: TocAnalysisRecord): Promise<void>;
    loadAnalysis(analyzeId: string): Promise<TocAnalysisRecord | undefined>;
    listAnalyses(tocId?: string): Promise<TocAnalysisRecord[]>;
    saveFeedback(record: TocFeedbackRecord): Promise<void>;
    listFeedback(analyzeId?: string): Promise<TocFeedbackRecord[]>;
    close(): void;
}

type Row = Record<string, unknown>;
function toJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}
function fromJson<T>(raw: unknown): T | undefined {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : undefined;
}

/** 纯函数：toc + analyses + feedback → 面板聚合视图（toc 倒序、analysis 正序、feedback 正序）。 */
export function buildIterations(
    tocs: TocRecord[],
    analyses: TocAnalysisRecord[],
    feedback: TocFeedbackRecord[],
): TocIterationView[] {
    const feedbackByAnalyze = new Map<string, TocFeedbackRecord[]>();
    for (const item of feedback) {
        const list = feedbackByAnalyze.get(item.analyzeId) ?? [];
        list.push(item);
        feedbackByAnalyze.set(item.analyzeId, list);
    }
    const analysesByToc = new Map<string, TocAnalysisRecord[]>();
    for (const analysis of analyses) {
        const list = analysesByToc.get(analysis.tocId) ?? [];
        list.push(analysis);
        analysesByToc.set(analysis.tocId, list);
    }
    return tocs
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((toc) => ({
            toc,
            analyses: (analysesByToc.get(toc.tocId) ?? [])
                .slice()
                .sort((a, b) => a.createdAt - b.createdAt)
                .map((analysis) => ({
                    ...analysis,
                    feedback: (feedbackByAnalyze.get(analysis.analyzeId) ?? [])
                        .slice()
                        .sort((a, b) => a.createdAt - b.createdAt),
                })),
        }));
}

/** 内存实现（测试） */
export class MemoryTocStore implements TocStore {
    private readonly tocs = new Map<string, TocRecord>();
    private readonly analyses = new Map<string, TocAnalysisRecord>();
    private readonly feedback = new Map<string, TocFeedbackRecord>();

    async saveToc(record: TocRecord): Promise<void> {
        this.tocs.set(record.tocId, structuredClone(record));
    }
    async loadToc(tocId: string): Promise<TocRecord | undefined> {
        return structuredClone(this.tocs.get(tocId));
    }
    async listTocs(): Promise<TocRecord[]> {
        return [...this.tocs.values()].map((record) => structuredClone(record));
    }
    async saveAnalysis(record: TocAnalysisRecord): Promise<void> {
        this.analyses.set(record.analyzeId, structuredClone(record));
    }
    async loadAnalysis(analyzeId: string): Promise<TocAnalysisRecord | undefined> {
        return structuredClone(this.analyses.get(analyzeId));
    }
    async listAnalyses(tocId?: string): Promise<TocAnalysisRecord[]> {
        return [...this.analyses.values()]
            .filter((record) => tocId === undefined || record.tocId === tocId)
            .map((record) => structuredClone(record));
    }
    async saveFeedback(record: TocFeedbackRecord): Promise<void> {
        this.feedback.set(record.feedbackId, structuredClone(record));
    }
    async listFeedback(analyzeId?: string): Promise<TocFeedbackRecord[]> {
        return [...this.feedback.values()]
            .filter((record) => analyzeId === undefined || record.analyzeId === analyzeId)
            .map((record) => structuredClone(record));
    }
    close(): void {
        this.tocs.clear();
        this.analyses.clear();
        this.feedback.clear();
    }
}

function createTocTables(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS toc_records (
            toc_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            goal_id TEXT NOT NULL,
            root_goal_id TEXT NOT NULL,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_toc_records_root ON toc_records(root_goal_id);
        CREATE TABLE IF NOT EXISTS toc_analyses (
            analyze_id TEXT PRIMARY KEY,
            toc_id TEXT NOT NULL,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_toc_analyses_toc ON toc_analyses(toc_id);
        CREATE TABLE IF NOT EXISTS toc_feedback (
            feedback_id TEXT PRIMARY KEY,
            analyze_id TEXT NOT NULL,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_toc_feedback_analyze ON toc_feedback(analyze_id);
    `);
}

/** node:sqlite 落地实现（独立连接；表结构懒建） */
export class SqliteTocStore implements TocStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA busy_timeout = 5000;');
        createTocTables(this.db);
    }

    async saveToc(record: TocRecord): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO toc_records (toc_id, task_id, goal_id, root_goal_id, json) VALUES (?, ?, ?, ?, ?)',
            )
            .run(record.tocId, record.taskId, record.goalId, record.rootGoalId, toJson(record));
    }
    async loadToc(tocId: string): Promise<TocRecord | undefined> {
        const row = this.db.prepare('SELECT json FROM toc_records WHERE toc_id = ?').get(tocId) as
            | Row
            | undefined;
        return row ? fromJson<TocRecord>(row.json) : undefined;
    }
    async listTocs(): Promise<TocRecord[]> {
        const rows = this.db.prepare('SELECT json FROM toc_records').all() as Row[];
        return rows.map((row) => fromJson<TocRecord>(row.json)).filter((r): r is TocRecord => !!r);
    }
    async saveAnalysis(record: TocAnalysisRecord): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO toc_analyses (analyze_id, toc_id, json) VALUES (?, ?, ?)',
            )
            .run(record.analyzeId, record.tocId, toJson(record));
    }
    async loadAnalysis(analyzeId: string): Promise<TocAnalysisRecord | undefined> {
        const row = this.db
            .prepare('SELECT json FROM toc_analyses WHERE analyze_id = ?')
            .get(analyzeId) as Row | undefined;
        return row ? fromJson<TocAnalysisRecord>(row.json) : undefined;
    }
    async listAnalyses(tocId?: string): Promise<TocAnalysisRecord[]> {
        const rows = (
            tocId === undefined
                ? this.db.prepare('SELECT json FROM toc_analyses').all()
                : this.db.prepare('SELECT json FROM toc_analyses WHERE toc_id = ?').all(tocId)
        ) as Row[];
        return rows
            .map((row) => fromJson<TocAnalysisRecord>(row.json))
            .filter((r): r is TocAnalysisRecord => !!r);
    }
    async saveFeedback(record: TocFeedbackRecord): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO toc_feedback (feedback_id, analyze_id, json) VALUES (?, ?, ?)',
            )
            .run(record.feedbackId, record.analyzeId, toJson(record));
    }
    async listFeedback(analyzeId?: string): Promise<TocFeedbackRecord[]> {
        const rows = (
            analyzeId === undefined
                ? this.db.prepare('SELECT json FROM toc_feedback').all()
                : this.db
                      .prepare('SELECT json FROM toc_feedback WHERE analyze_id = ?')
                      .all(analyzeId)
        ) as Row[];
        return rows
            .map((row) => fromJson<TocFeedbackRecord>(row.json))
            .filter((r): r is TocFeedbackRecord => !!r);
    }
    close(): void {
        this.db.close();
    }
}
