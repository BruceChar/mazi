import type {
    GoalContract,
    ToolRegistry,
    ToolRequirement,
    ToolResolution,
    ToolSpec,
} from '@mazi/core';

/**
 * Goal 工具域 → 需求声明（仅用于从注册表解析白名单 ToolSpec）。
 * 域内工具一律按 optional 解析：缺失仅降级（requiredTools 里的强依赖在 planner 单独校验）。
 */
export function allowedToolRequirements(goal: GoalContract): ToolRequirement[] {
    if (goal.allowedTools === 'all-registry') {
        return [{ nameOrCapability: 'all-registry', required: false }];
    }
    return goal.allowedTools.map((name) => ({ nameOrCapability: name, required: false }));
}

/** 从注册表解析 Goal 白名单内的全部工具 */
export function resolveAllowedTools(goal: GoalContract, registry: ToolRegistry): ToolResolution {
    const reqs = allowedToolRequirements(goal);
    if (reqs.length === 1 && reqs[0]?.nameOrCapability === 'all-registry') {
        const tools = registry.list();
        return { tools, missingRequired: [], missingOptional: [] };
    }
    return registry.resolve(reqs);
}

/** 权限级别顺序（v1.2 §3.3）：级别越高代表能力越大 */
export const PERMISSION_ORDER: readonly string[] = [
    'text',
    'read-only',
    'draft',
    'approved',
    'autonomous',
];

export function permissionRank(level: string): number {
    const rank = PERMISSION_ORDER.indexOf(level);
    return rank === -1 ? -1 : rank;
}

/**
 * Turn 可用权限 = min(契约声明权限, 白名单工具所需最低权限的最大值)。
 * minPermission 是“允许该工具所需的最低会话权限”，会话权限必须 >= 它。
 */
export function convergePermission(declared: string, tools: ToolSpec[]): string {
    const toolNeed = tools.reduce(
        (acc, tool) => Math.max(acc, permissionRank(tool.minPermission)),
        0,
    );
    const declaredRank = permissionRank(declared);
    if (declaredRank < 0) {
        return 'text';
    }
    if (toolNeed > declaredRank) {
        // 理论不可达（工具域已由 Goal 声明约束），防御性收敛
        return PERMISSION_ORDER[declaredRank] ?? 'text';
    }
    return declared;
}

/** 依据 Goal 网络约束与工具副作用域推导 sandbox 网络策略（MVP：仅 network 约束参与） */
export function deriveSandboxNetworkAllowInternet(goal: GoalContract): boolean {
    for (const constraint of goal.constraints) {
        if (constraint.kind === 'network') {
            return constraint.rule === 'on';
        }
    }
    return false;
}
