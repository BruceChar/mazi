/**
 * question-store —— 用户问题与标签的 SQLite 存储（user_questions + question_labels）。
 *
 * 问题行由 SqliteBehaviorStore 在写入 input 时投影落库（同一 DB 连接）；
 * 本模块负责查询、标签追加与级联清理。见 docs/用户问题标签与分类设计.md §4。
 */

import { DatabaseSync } from 'node:sqlite';
import type {
    LabelAxis,
    QuestionLabelInput,
    QuestionLabelSource,
    QuestionLabelView,
    UserQuestionRecord,
} from '@mazi/libs';

export type { QuestionLabelInput } from '@mazi/libs';

export interface QuestionQuery {
    userId?: string;
    sessionId?: string;
    /** ts >= from */
    from?: number;
    /** ts <= to */
    to?: number;
    limit?: number;
}

export interface QuestionStore {
    list(query?: QuestionQuery): Promise<UserQuestionRecord[]>;
    get(questionId: string): Promise<UserQuestionRecord | undefined>;
    addLabels(questionId: string, labels: readonly QuestionLabelInput[]): Promise<void>;
    listLabels(questionId: string): Promise<QuestionLabelView[]>;
    listLabelsFor(questionIds: readonly string[]): Promise<Map<string, QuestionLabelView[]>>;
    clearBySession(sessionId: string): Promise<void>;
    close(): void;
}

/** 问题与标签表（behavior-store 的 input 投影与 question-store 共享）。 */
export function ensureQuestionTables(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_questions (
            question_id   TEXT PRIMARY KEY,
            behavior_id   TEXT NOT NULL,
            ts            INTEGER NOT NULL,
            user_id       TEXT,
            session_id    TEXT NOT NULL,
            conversation_id TEXT,
            text          TEXT NOT NULL,
            derived       INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_questions_user ON user_questions(user_id, ts);
        CREATE INDEX IF NOT EXISTS idx_user_questions_session ON user_questions(session_id, ts);
        CREATE TABLE IF NOT EXISTS question_labels (
            question_id  TEXT NOT NULL,
            axis         TEXT NOT NULL,
            label        TEXT NOT NULL,
            source       TEXT NOT NULL,
            confidence   REAL,
            taxonomy_version INTEGER,
            model        TEXT,
            created_at   INTEGER NOT NULL,
            PRIMARY KEY (question_id, axis, label, source)
        );
        CREATE INDEX IF NOT EXISTS idx_question_labels_axis ON question_labels(axis, label);
    `);
}

interface QuestionRow {
    question_id: string;
    ts: number;
    user_id: string | null;
    session_id: string;
    conversation_id: string | null;
    text: string;
    derived: number;
    created_at: number;
}

function toRecord(row: QuestionRow): UserQuestionRecord {
    return {
        questionId: row.question_id,
        ts: row.ts,
        text: row.text,
        derived: row.derived === 1,
        sessionId: row.session_id,
        ...(row.user_id !== null ? { userId: row.user_id } : {}),
        ...(row.conversation_id !== null ? { conversationId: row.conversation_id } : {}),
        createdAt: row.created_at,
    };
}

interface LabelRow {
    axis: string;
    label: string;
    source: string;
    confidence: number | null;
    taxonomy_version: number | null;
    model: string | null;
}

function toLabel(row: LabelRow): QuestionLabelView {
    return {
        axis: row.axis as LabelAxis,
        label: row.label,
        source: row.source as QuestionLabelSource,
        ...(row.confidence !== null ? { confidence: row.confidence } : {}),
        ...(row.taxonomy_version !== null ? { taxonomyVersion: row.taxonomy_version } : {}),
        ...(row.model !== null ? { model: row.model } : {}),
    };
}

/** node:sqlite 落地实现（独立连接；与 behavior-store 共享同一 DB 文件）。 */
export class SqliteQuestionStore implements QuestionStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        ensureQuestionTables(this.db);
    }

    async list(query: QuestionQuery = {}): Promise<UserQuestionRecord[]> {
        const where: string[] = [];
        const params: Array<string | number> = [];
        if (query.userId !== undefined) {
            where.push('user_id = ?');
            params.push(query.userId);
        }
        if (query.sessionId !== undefined) {
            where.push('session_id = ?');
            params.push(query.sessionId);
        }
        if (query.from !== undefined) {
            where.push('ts >= ?');
            params.push(query.from);
        }
        if (query.to !== undefined) {
            where.push('ts <= ?');
            params.push(query.to);
        }
        const limit = query.limit ?? 200;
        const sql = `SELECT question_id, ts, user_id, session_id, conversation_id, text, derived, created_at
            FROM user_questions
            ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY ts ASC LIMIT ?`;
        const rows = this.db.prepare(sql).all(...params, limit) as unknown as QuestionRow[];
        return rows.map(toRecord);
    }

    async get(questionId: string): Promise<UserQuestionRecord | undefined> {
        const row = this.db
            .prepare(
                'SELECT question_id, ts, user_id, session_id, conversation_id, text, derived, created_at FROM user_questions WHERE question_id = ?',
            )
            .get(questionId) as QuestionRow | undefined;
        return row ? toRecord(row) : undefined;
    }

    async addLabels(questionId: string, labels: readonly QuestionLabelInput[]): Promise<void> {
        const insert = this.db.prepare(
            'INSERT OR REPLACE INTO question_labels (question_id, axis, label, source, confidence, taxonomy_version, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        );
        for (const row of labels) {
            insert.run(
                questionId,
                row.axis,
                row.label,
                row.source,
                row.confidence ?? null,
                row.taxonomyVersion ?? null,
                row.model ?? null,
                Date.now(),
            );
        }
    }

    async listLabels(questionId: string): Promise<QuestionLabelView[]> {
        const rows = this.db
            .prepare(
                'SELECT axis, label, source, confidence, taxonomy_version, model FROM question_labels WHERE question_id = ? ORDER BY created_at ASC, axis ASC, label ASC',
            )
            .all(questionId) as unknown as LabelRow[];
        return rows.map(toLabel);
    }

    async listLabelsFor(questionIds: readonly string[]): Promise<Map<string, QuestionLabelView[]>> {
        const result = new Map<string, QuestionLabelView[]>();
        if (questionIds.length === 0) return result;
        const placeholders = questionIds.map(() => '?').join(', ');
        const select = this.db.prepare(
            `SELECT question_id, axis, label, source, confidence, taxonomy_version, model FROM question_labels WHERE question_id IN (${placeholders}) ORDER BY created_at ASC, axis ASC, label ASC`,
        );
        for (const questionId of questionIds) {
            const rows = select.all(questionId) as unknown as Array<
                LabelRow & { question_id: string }
            >;
            result.set(questionId, rows.map(toLabel));
        }
        return result;
    }

    async clearBySession(sessionId: string): Promise<void> {
        this.db
            .prepare(
                'DELETE FROM question_labels WHERE question_id IN (SELECT question_id FROM user_questions WHERE session_id = ?)',
            )
            .run(sessionId);
        this.db.prepare('DELETE FROM user_questions WHERE session_id = ?').run(sessionId);
    }

    close(): void {
        this.db.close();
    }
}
