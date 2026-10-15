/**
 * capabilities/permission.ts —— 权限天花板语义（docs/能力包规范.md §9.1）。
 *
 * 挂载能力包 = 一次委托：包内生效档位 = min(当前 Goal 档位, manifest.permissionCeiling)。
 * 档位序与 runtime tool-gateway 的 CAPABILITIES_BY_LEVEL 单调一致：
 * text ⊂ read-only ⊂ workspace-write ⊂ draft ⊂ approved ⊂ autonomous。
 */

import type { PermissionLevel } from '@mazi/core';

const LEVEL_RANK: Record<string, number> = {
    text: 0,
    'read-only': 1,
    'workspace-write': 2,
    draft: 3,
    approved: 4,
    autonomous: 5,
};

export const PERMISSION_LEVELS: readonly string[] = Object.keys(LEVEL_RANK);

export function permissionLevelRank(level: PermissionLevel): number | undefined {
    return LEVEL_RANK[level];
}

export function isKnownPermissionLevel(level: unknown): level is PermissionLevel {
    return typeof level === 'string' && LEVEL_RANK[level] !== undefined;
}

/** 生效档位：取双方更低者；未知档位保守取 ceiling。 */
export function clampPermissionLevel(
    ceiling: PermissionLevel,
    requested: PermissionLevel,
): PermissionLevel {
    const ceilingRank = permissionLevelRank(ceiling);
    const requestedRank = permissionLevelRank(requested);
    if (ceilingRank === undefined) return requested;
    if (requestedRank === undefined) return ceiling;
    return requestedRank <= ceilingRank ? requested : ceiling;
}
