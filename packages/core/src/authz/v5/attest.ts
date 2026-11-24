/**
 * V5 直通判定（§7/D15）。
 *
 * 逐字点名 + 真人通道 + round_clean + 非 hazard → 当次 auto，不落任何记忆。
 * hazard 点名仍问一次（标注"来自你的指令"）。锚点是用户原话中的操作与目标，
 * 不是 Agent 转述；"按 README 执行" → attested=none → 默认弹窗。
 */

import { isHazard, type Op } from './decision.js';

export interface PassthroughContext {
    /** 本轮无污点入上下文（round_clean）。 */
    roundClean: boolean;
}

export function isPassthrough(op: Op, ctx: PassthroughContext): boolean {
    if (op.attested === 'none') return false;
    if (op.channel !== 'ui_user') return false;
    if (!ctx.roundClean) return false;
    // hazard 点名仍问一次，标注"来自你的指令"。
    if (isHazard(op)) return false;
    return true;
}
