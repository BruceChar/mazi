/**
 * iteration-tracker —— 系统迭代记录的状态机编排（分析报告 → 系统改动的闭环）。
 *
 * 版本快照（base/applied）由 API 层读取并传入，runtime 不依赖 git；
 * 状态迁移是唯一合法集合（见 docs/web/迭代面板设计.md §2.3），记录不可删除（审计留痕）。
 */

import { ulid } from '@mazi/core';
import type { IterationRecordView, IterationStatus, SystemVersionRef } from '@mazi/libs';
import { canTransition, ITERATION_STATUSES } from '@mazi/libs';
import type { IterationStore } from './iteration-store.js';

// 状态机（表 + 判定）的唯一实现在 @mazi/libs，前后端共用；此处只做透传导出，
// 保持 @mazi/runtime 既有对外符号不变。
export { canTransition, ITERATION_STATUSES };

export interface IterationTrackerDeps {
    store: IterationStore;
    now?: () => number;
}

export interface CreateIterationInput {
    title: string;
    intent?: string;
    analyzeId?: string;
    tocId?: string;
    base: SystemVersionRef;
}

/** PATCH 语义：字段缺省 = 不改；status 变更时 applied 才是新的应用快照。 */
export interface UpdateIterationPatch {
    status?: IterationStatus;
    title?: string;
    intent?: string;
    notes?: string;
    applied?: SystemVersionRef;
}

export class IterationTracker {
    private readonly store: IterationStore;
    private readonly now: () => number;

    constructor(deps: IterationTrackerDeps) {
        this.store = deps.store;
        this.now = deps.now ?? Date.now;
    }

    /** 新建迭代记录：状态 proposed，base 为创建时系统版本快照。 */
    async create(input: CreateIterationInput): Promise<IterationRecordView> {
        const now = this.now();
        const record: IterationRecordView = {
            iterationId: ulid(),
            ...(input.analyzeId !== undefined ? { analyzeId: input.analyzeId } : {}),
            ...(input.tocId !== undefined ? { tocId: input.tocId } : {}),
            title: input.title,
            intent: input.intent ?? '',
            status: 'proposed',
            base: input.base,
            notes: '',
            createdAt: now,
            updatedAt: now,
        };
        await this.store.save(record);
        return record;
    }

    /** 修改状态/文案；非法迁移或未知 id 抛错（调用方映射 HTTP 状态）。 */
    async update(iterationId: string, patch: UpdateIterationPatch): Promise<IterationRecordView> {
        const record = await this.store.load(iterationId);
        if (!record) {
            throw new Error(`iteration not found: ${iterationId}`);
        }
        this.applyStatus(record, patch);
        applyText(record, patch);
        record.updatedAt = this.now();
        await this.store.save(record);
        return record;
    }

    list(): Promise<IterationRecordView[]> {
        return this.store.list();
    }

    /** 校验并落到目标状态；applied 迁移可携带新的应用版本快照。 */
    private applyStatus(record: IterationRecordView, patch: UpdateIterationPatch): void {
        const status = patch.status;
        if (status === undefined) return;
        if (!canTransition(record.status, status)) {
            throw new Error(`invalid transition: ${record.status} -> ${status}`);
        }
        record.status = status;
        if (status === 'applied' && patch.applied !== undefined) {
            record.applied = patch.applied;
        }
    }
}

/** 文案字段缺省 = 不改；显式空串可用于清空 notes/intent。 */
function applyText(record: IterationRecordView, patch: UpdateIterationPatch): void {
    if (patch.title !== undefined) record.title = patch.title;
    if (patch.intent !== undefined) record.intent = patch.intent;
    if (patch.notes !== undefined) record.notes = patch.notes;
}
