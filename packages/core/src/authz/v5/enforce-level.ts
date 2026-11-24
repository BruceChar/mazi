/**
 * V5 强制层放行域矩阵（§11/D17）。
 *
 * auth 是决策层不是强制层：强制层成熟度决定执行类与出站类能否进记忆/例行。
 * - none（纯 auth）：执行/出站限 once，不进指纹记忆、不进例行；
 * - unix：专用 uid/文件权限/凭证隔离，闭合 external 与 B1 残余，执行/出站仍受限；
 * - network：uid 限网/代理白名单，执行/出站可 session 记忆、可进例行；
 * - full：完整沙箱，全量，auth 降位为 UX 层。
 *
 * 本模块只判定放行域，不实现强制层本身。
 */

export type EnforceLevel = 'none' | 'unix' | 'network' | 'full';
export type ActionClass = 'exec' | 'egress';

const MEMORY_DOMAIN: Record<EnforceLevel, Record<ActionClass, boolean>> = {
    none: { exec: false, egress: false },
    unix: { exec: false, egress: false },
    network: { exec: true, egress: true },
    full: { exec: true, egress: true },
};

const ROUTINE_DOMAIN: Record<EnforceLevel, Record<ActionClass, boolean>> = {
    none: { exec: false, egress: false },
    unix: { exec: false, egress: false },
    network: { exec: true, egress: true },
    full: { exec: true, egress: true },
};

/** 执行/出站类能否进指纹记忆（session 及以上）。 */
export function allowsMemory(level: EnforceLevel, kind: ActionClass): boolean {
    return MEMORY_DOMAIN[level][kind];
}

/** 执行/出站类能否进例行。 */
export function allowsRoutine(level: EnforceLevel, kind: ActionClass): boolean {
    return ROUTINE_DOMAIN[level][kind];
}
