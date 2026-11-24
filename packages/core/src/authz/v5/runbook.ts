/**
 * V5 运行清单与非交互 fail-closed（§12/D16）。
 *
 * 运行清单 = 人写的一次性预记忆，可含 hazard 类，创建时逐条键入确认；清单外
 * 拒绝；清单不豁免 B1–B4。非交互无审批者一律 fail-closed：应弹窗操作 →
 * deny + 留痕。清单是唯一允许 hazard 类免弹窗执行的通道。
 */

import { bottom, type Op } from './decision.js';

export interface RunbookEntry {
    key: string;
    summary: string;
    /** 创建时逐条键入确认。 */
    typedConfirmed: boolean;
}

export class Runbook {
    private readonly entries = new Map<string, RunbookEntry>();

    add(entry: RunbookEntry): void {
        if (!entry.typedConfirmed) {
            throw new Error('运行清单条目需创建时逐条键入确认（§12）');
        }
        this.entries.set(entry.key, entry);
    }

    allows(key: string): boolean {
        return this.entries.has(key);
    }

    remove(key: string): boolean {
        return this.entries.delete(key);
    }

    list(): readonly RunbookEntry[] {
        return [...this.entries.values()];
    }
}

/**
 * 非交互决策：底线优先；清单内 → auto（唯一 hazard 免弹窗通道）；其余 fail-closed deny。
 * 留痕由调用方在 deny 后写入审计。
 */
export function nonInteractiveDecide(op: Op, inRunbook: boolean): 'auto' | 'deny' {
    if (bottom(op) === 'deny') return 'deny';
    if (inRunbook) return 'auto';
    return 'deny';
}
