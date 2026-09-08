/**
 * goal-store —— Goal/Task/Step 归因坐标系存储（迁移并存，C1 默认裁决 ②）。
 * 独立于旧 sessions/turns/steps 表；新表 goals/tasks/steps（root_goal_id 列便于按根投影），
 * 全部消费方迁移后删除旧表。坐标契约：core/src/goal-coordinate.ts（core 未公共导出前相对引用）。
 */

import { DatabaseSync } from 'node:sqlite';
import type { Goal, Step, Task } from '../../../core/src/goal-coordinate.js';

export interface GoalStore {
    saveGoal(goal: Goal): Promise<void>;
    loadGoal(goalId: string): Promise<Goal | undefined>;
    listGoalsByRoot(rootGoalId: string): Promise<Goal[]>;
    saveTask(task: Task): Promise<void>;
    loadTask(taskId: string): Promise<Task | undefined>;
    listTasks(goalId: string): Promise<Task[]>;
    saveStep(step: Step): Promise<void>;
    loadStep(stepId: string): Promise<Step | undefined>;
    listSteps(taskId: string): Promise<Step[]>;
    /** 级联删除一棵 Goal 树（goals + 其 tasks + 其 steps）；Conversation 删除用 */
    deleteGoalTree(rootGoalId: string): Promise<void>;
    close(): void;
}

type Row = Record<string, unknown>;
function toJson(value: unknown): string | null {
    return value === undefined ? null : JSON.stringify(value);
}
function fromJson<T>(raw: unknown): T | undefined {
    return typeof raw === 'string' ? (JSON.parse(raw) as T) : undefined;
}

/** 内存实现（测试/轻量运行） */
export class MemoryGoalStore implements GoalStore {
    private readonly goals = new Map<string, Goal>();
    private readonly tasks = new Map<string, Task>();
    private readonly steps = new Map<string, Step>();

    async saveGoal(goal: Goal): Promise<void> {
        this.goals.set(goal.goalId, structuredClone(goal));
    }
    async loadGoal(goalId: string): Promise<Goal | undefined> {
        return structuredClone(this.goals.get(goalId));
    }
    async listGoalsByRoot(rootGoalId: string): Promise<Goal[]> {
        return [...this.goals.values()]
            .filter((g) => g.rootGoalId === rootGoalId)
            .map((g) => structuredClone(g));
    }
    async saveTask(task: Task): Promise<void> {
        this.tasks.set(task.taskId, structuredClone(task));
    }
    async loadTask(taskId: string): Promise<Task | undefined> {
        return structuredClone(this.tasks.get(taskId));
    }
    async listTasks(goalId: string): Promise<Task[]> {
        return [...this.tasks.values()]
            .filter((t) => t.goalId === goalId)
            .map((t) => structuredClone(t));
    }
    async saveStep(step: Step): Promise<void> {
        this.steps.set(step.stepId, structuredClone(step));
    }
    async loadStep(stepId: string): Promise<Step | undefined> {
        return structuredClone(this.steps.get(stepId));
    }
    async listSteps(taskId: string): Promise<Step[]> {
        return [...this.steps.values()]
            .filter((s) => s.taskId === taskId)
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((s) => structuredClone(s));
    }
    async deleteGoalTree(rootGoalId: string): Promise<void> {
        const roots = [...this.goals.values()].filter((g) => g.rootGoalId === rootGoalId);
        const goalIds = new Set(roots.map((g) => g.goalId));
        for (const g of roots) {
            this.goals.delete(g.goalId);
        }
        const tasks = [...this.tasks.values()].filter((t) => goalIds.has(t.goalId));
        const taskIds = new Set(tasks.map((t) => t.taskId));
        for (const t of tasks) {
            this.tasks.delete(t.taskId);
        }
        for (const s of [...this.steps.values()]) {
            if (taskIds.has(s.taskId)) {
                this.steps.delete(s.stepId);
            }
        }
    }
    close(): void {
        this.goals.clear();
        this.tasks.clear();
        this.steps.clear();
    }
}

function createGoalTables(db: DatabaseSync): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS goal_nodes (
            goal_id TEXT PRIMARY KEY,
            root_goal_id TEXT NOT NULL,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goal_nodes_root ON goal_nodes(root_goal_id);
        CREATE TABLE IF NOT EXISTS goal_tasks (
            task_id TEXT PRIMARY KEY,
            goal_id TEXT NOT NULL,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goal_tasks_goal ON goal_tasks(goal_id);
        CREATE TABLE IF NOT EXISTS goal_steps (
            step_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            goal_id TEXT NOT NULL,
            json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_goal_steps_task ON goal_steps(task_id);
    `);
}

/** node:sqlite 落地实现（独立 db 连接；表结构 createGoalTables 懒建） */
export class SqliteGoalStore implements GoalStore {
    private readonly db: DatabaseSync;

    constructor(dbPath: string) {
        this.db = new DatabaseSync(dbPath);
        createGoalTables(this.db);
    }

    async saveGoal(goal: Goal): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO goal_nodes (goal_id, root_goal_id, json) VALUES (?, ?, ?)',
            )
            .run(goal.goalId, goal.rootGoalId, toJson(goal));
    }
    async loadGoal(goalId: string): Promise<Goal | undefined> {
        const row = this.db.prepare('SELECT json FROM goal_nodes WHERE goal_id = ?').get(goalId) as
            | Row
            | undefined;
        return row ? fromJson<Goal>(row.json) : undefined;
    }
    async listGoalsByRoot(rootGoalId: string): Promise<Goal[]> {
        const rows = this.db
            .prepare('SELECT json FROM goal_nodes WHERE root_goal_id = ?')
            .all(rootGoalId) as Row[];
        return rows.map((r) => fromJson<Goal>(r.json)).filter((g): g is Goal => g !== undefined);
    }
    async saveTask(task: Task): Promise<void> {
        this.db
            .prepare('INSERT OR REPLACE INTO goal_tasks (task_id, goal_id, json) VALUES (?, ?, ?)')
            .run(task.taskId, task.goalId, toJson(task));
    }
    async loadTask(taskId: string): Promise<Task | undefined> {
        const row = this.db.prepare('SELECT json FROM goal_tasks WHERE task_id = ?').get(taskId) as
            | Row
            | undefined;
        return row ? fromJson<Task>(row.json) : undefined;
    }
    async listTasks(goalId: string): Promise<Task[]> {
        const rows = this.db
            .prepare('SELECT json FROM goal_tasks WHERE goal_id = ?')
            .all(goalId) as Row[];
        return rows.map((r) => fromJson<Task>(r.json)).filter((t): t is Task => t !== undefined);
    }
    async saveStep(step: Step): Promise<void> {
        this.db
            .prepare(
                'INSERT OR REPLACE INTO goal_steps (step_id, task_id, goal_id, json) VALUES (?, ?, ?, ?)',
            )
            .run(step.stepId, step.taskId, step.goalId, toJson(step));
    }
    async loadStep(stepId: string): Promise<Step | undefined> {
        const row = this.db.prepare('SELECT json FROM goal_steps WHERE step_id = ?').get(stepId) as
            | Row
            | undefined;
        return row ? fromJson<Step>(row.json) : undefined;
    }
    async listSteps(taskId: string): Promise<Step[]> {
        const rows = this.db
            .prepare('SELECT json FROM goal_steps WHERE task_id = ?')
            .all(taskId) as Row[];
        return rows.map((r) => fromJson<Step>(r.json)).filter((s): s is Step => s !== undefined);
    }
    async deleteGoalTree(rootGoalId: string): Promise<void> {
        const goalRows = this.db
            .prepare('SELECT goal_id FROM goal_nodes WHERE root_goal_id = ?')
            .all(rootGoalId) as Row[];
        for (const row of goalRows) {
            const goalId = String(row.goal_id);
            const taskRows = this.db
                .prepare('SELECT task_id FROM goal_tasks WHERE goal_id = ?')
                .all(goalId) as Row[];
            for (const t of taskRows) {
                this.db.prepare('DELETE FROM goal_steps WHERE task_id = ?').run(String(t.task_id));
            }
            this.db.prepare('DELETE FROM goal_tasks WHERE goal_id = ?').run(goalId);
            this.db.prepare('DELETE FROM goal_nodes WHERE goal_id = ?').run(goalId);
        }
    }
    close(): void {
        this.db.close();
    }
}
