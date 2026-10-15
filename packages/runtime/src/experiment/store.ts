/**
 * ExperimentStore —— 实验日志（append-only JSONL，一次实验一个文件）
 * 见 docs/AB测试设计.md §6。
 *
 * 与 harness 事件日志（events/<rootGoalId>.jsonl）分离：这里只记录实验设计、
 * 自变量、两臂指标与人工复盘；运行事实仍在 Goal/Step/事件存储中，以 rootGoalId 互引。
 */

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { ulid } from '@mazi/core';

/** 实验日志事件（闭集）。 */
export type ExperimentEventType =
    | 'experiment.created'
    | 'experiment.started'
    | 'arm.planned'
    | 'arm.started'
    | 'arm.ended'
    | 'experiment.completed'
    | 'experiment.failed'
    | 'experiment.reviewed';

export interface ExperimentEvent {
    eventId: string;
    experimentId: string;
    type: ExperimentEventType;
    at: number;
    payload: Record<string, unknown>;
}

export function newExperimentEvent(
    experimentId: string,
    type: ExperimentEventType,
    payload: Record<string, unknown> = {},
    at: number = Date.now(),
): ExperimentEvent {
    return { eventId: ulid(), experimentId, type, at, payload };
}

/** ULID 形态校验（防目录穿越：id 来自 URL，必须只允许 Crockford base32）。 */
export function isExperimentId(id: string): boolean {
    return /^[0-9A-Z]{26}$/.test(id);
}

export interface ExperimentStore {
    append(event: ExperimentEvent): Promise<void>;
    read(experimentId: string): Promise<ExperimentEvent[]>;
    /** 全部实验的原始日志（每个实验按其文件行序）。 */
    list(): Promise<ExperimentEvent[][]>;
    remove(experimentId: string): Promise<boolean>;
}

function parseLines(raw: string, experimentId: string): ExperimentEvent[] {
    const events: ExperimentEvent[] = [];
    for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
            const parsed = JSON.parse(line) as ExperimentEvent;
            if (parsed.experimentId === experimentId && typeof parsed.type === 'string') {
                events.push(parsed);
            }
        } catch {
            // 跳过损坏行（重放尽力而为；写入端 append-only 保证正常路径完整）
        }
    }
    return events;
}

/** 文件实现：$MAZI_HOME/experiments/<experimentId>.jsonl。 */
export class FileExperimentStore implements ExperimentStore {
    constructor(
        private readonly dir: string,
        private readonly onError?: (message: string) => void,
    ) {}

    private filePath(experimentId: string): string {
        return join(this.dir, experimentId + '.jsonl');
    }

    async append(event: ExperimentEvent): Promise<void> {
        if (!isExperimentId(event.experimentId)) {
            throw new Error('非法实验 id：' + event.experimentId);
        }
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(this.filePath(event.experimentId), JSON.stringify(event) + '\n', 'utf8');
    }

    async read(experimentId: string): Promise<ExperimentEvent[]> {
        if (!isExperimentId(experimentId)) return [];
        const file = this.filePath(experimentId);
        if (!existsSync(file)) return [];
        try {
            return parseLines(readFileSync(file, 'utf8'), experimentId);
        } catch (error) {
            this.onError?.('读取实验日志失败：' + String(error));
            return [];
        }
    }

    async list(): Promise<ExperimentEvent[][]> {
        if (!existsSync(this.dir)) return [];
        const files = readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'));
        const logs: ExperimentEvent[][] = [];
        for (const name of files) {
            const experimentId = name.slice(0, -'.jsonl'.length);
            const events = await this.read(experimentId);
            if (events.length > 0) logs.push(events);
        }
        return logs;
    }

    async remove(experimentId: string): Promise<boolean> {
        if (!isExperimentId(experimentId)) return false;
        const file = this.filePath(experimentId);
        if (!existsSync(file)) return false;
        unlinkSync(file);
        return true;
    }
}

/** 进程内实现（测试 / 无状态宿主）。 */
export class MemoryExperimentStore implements ExperimentStore {
    private readonly logs = new Map<string, ExperimentEvent[]>();

    async append(event: ExperimentEvent): Promise<void> {
        const list = this.logs.get(event.experimentId) ?? [];
        list.push(event);
        this.logs.set(event.experimentId, list);
    }

    async read(experimentId: string): Promise<ExperimentEvent[]> {
        return [...(this.logs.get(experimentId) ?? [])];
    }

    async list(): Promise<ExperimentEvent[][]> {
        return [...this.logs.values()].map((events) => [...events]);
    }

    async remove(experimentId: string): Promise<boolean> {
        return this.logs.delete(experimentId);
    }
}
