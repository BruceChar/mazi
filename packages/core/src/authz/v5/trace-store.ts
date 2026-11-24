/**
 * V5 auto 留痕视图（§10/D19）。
 *
 * 每次 auto（指纹/例行/直通/读日志）一条记录：三问答案、类别、模式依据、
 * 目标绑定、结果。一处可查、可逐条撤销。留痕视图是安全基础设施——没有它
 * 校准就没有负反馈来源。
 */

export type TraceBasis = 'read-log' | 'passthrough' | 'memory' | 'routine';

export interface TraceEntry {
    id: string;
    at: number;
    basis: TraceBasis;
    target: string;
    binding?: string;
    detail: string;
}

export interface TraceInput {
    basis: TraceBasis;
    target: string;
    binding?: string;
    detail: string;
    id?: string;
}

let traceSeq = 0;

export class TraceStore {
    private readonly entries: TraceEntry[] = [];

    record(input: TraceInput, at: number = Date.now()): TraceEntry {
        const entry: TraceEntry = {
            id: input.id ?? `trace-${++traceSeq}`,
            at,
            basis: input.basis,
            target: input.target,
            ...(input.binding ? { binding: input.binding } : {}),
            detail: input.detail,
        };
        this.entries.push(entry);
        return entry;
    }

    list(): readonly TraceEntry[] {
        return [...this.entries];
    }

    revoke(id: string): boolean {
        const index = this.entries.findIndex((entry) => entry.id === id);
        if (index === -1) return false;
        this.entries.splice(index, 1);
        return true;
    }
}
