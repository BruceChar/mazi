import { readFileSync } from 'node:fs';
import type { EvalDifficulty, EvalRiskLevel, EvalTask } from './types.js';

const DIFFICULTIES = new Set<EvalDifficulty>(['simple', 'medium', 'hard', 'long-horizon']);
const RISKS = new Set<EvalRiskLevel>(['read-only', 'workspace-write', 'external', 'irreversible']);

function stringList(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new Error(`${field} 必须是字符串数组`);
    }
    return value;
}

export function parseEvalTasks(input: unknown): EvalTask[] {
    if (!Array.isArray(input)) throw new Error('评测数据集必须是任务数组');
    const ids = new Set<string>();
    return input.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null) {
            throw new Error(`tasks[${index}] 必须是对象`);
        }
        const task = raw as Record<string, unknown>;
        const id = typeof task.id === 'string' ? task.id.trim() : '';
        if (id.length === 0) throw new Error(`tasks[${index}].id 必填`);
        if (ids.has(id)) throw new Error(`重复任务 id：${id}`);
        ids.add(id);
        if (!DIFFICULTIES.has(task.difficulty as EvalDifficulty)) {
            throw new Error(`${id}.difficulty 非法`);
        }
        if (!RISKS.has(task.risk as EvalRiskLevel)) throw new Error(`${id}.risk 非法`);
        if (typeof task.title !== 'string' || typeof task.input !== 'string') {
            throw new Error(`${id} 缺少 title/input`);
        }
        if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
            throw new Error(`${id} 至少需要一条验收条件`);
        }
        return {
            id,
            title: task.title,
            difficulty: task.difficulty as EvalDifficulty,
            category: typeof task.category === 'string' ? task.category : 'general',
            risk: task.risk as EvalRiskLevel,
            input: task.input,
            allowedTools: stringList(task.allowedTools, `${id}.allowedTools`),
            ...(task.expectedTools !== undefined
                ? {
                      expectedTools: stringList(task.expectedTools, `${id}.expectedTools`),
                  }
                : {}),
            acceptance: task.acceptance.map((item, conditionIndex) => {
                if (typeof item !== 'object' || item === null) {
                    throw new Error(`${id}.acceptance[${conditionIndex}] 非法`);
                }
                const condition = item as Record<string, unknown>;
                const conditionId = typeof condition.id === 'string' ? condition.id.trim() : '';
                if (conditionId.length === 0) {
                    throw new Error(`${id}.acceptance[${conditionIndex}].id 必填`);
                }
                return {
                    id: conditionId,
                    description:
                        typeof condition.description === 'string'
                            ? condition.description
                            : conditionId,
                    kind: condition.kind === 'semantic' ? 'semantic' : 'deterministic',
                };
            }),
            ...(typeof task.budget === 'object' && task.budget !== null
                ? { budget: task.budget as EvalTask['budget'] }
                : {}),
            ...(typeof task.projectFixture === 'string'
                ? { projectFixture: task.projectFixture }
                : {}),
            ...(task.tags !== undefined ? { tags: stringList(task.tags, `${id}.tags`) } : {}),
        };
    });
}

export function loadEvalDataset(path: string): EvalTask[] {
    return parseEvalTasks(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
