import type { FlagSnapshot } from './flags.js';
import type { ModelRef } from './provider.js';

/** 权限级别 */
export type PermissionLevel = 'text' | 'read-only' | 'draft' | 'approved' | 'autonomous';

/** 工具可作用的副作用域 */
export type SideEffectScope = 'fs' | 'net' | 'process' | 'external-api';

/** 沙箱执行配置 */
export interface SandboxSpec {
    enabled: boolean;
    network?: {
        allowInternet: boolean;
        allowedHosts?: string[];
    };
    filesystem?: {
        writableRoots?: string[];
    };
    process?: {
        allowSpawn: boolean;
    };
}

/** 已解析、可执行的工具规格 */
export interface ToolSpec {
    name: string;
    description: string;
    /** TypeBox schema，与 pi-ai Tool.parameters 对齐 */
    parameters: unknown;
    minPermission: PermissionLevel;
    /** 不可逆标记，触发审批门 */
    irreversible?: boolean;
    sideEffects: SideEffectScope[];
}

/** Plan 层为每个 Turn 组装的执行资源包 */
export interface Capacity {
    /** 路由决策选中的模型 */
    model: ModelRef;
    /** 本次允许调用的工具白名单 */
    tools: ToolSpec[];
    /** 本次允许的权限级别 */
    permission: PermissionLevel;
    /** 预算上限（在目标契约内进一步收紧） */
    budget: {
        maxSteps?: number;
        maxTokens?: number;
        maxCostUsd?: number;
        timeoutMs?: number;
    };
    /** 执行上下文（沙箱配置、网络白名单、文件挂载） */
    sandbox: SandboxSpec;
    /** 本次执行的 Feature Flag 子集（已求值） */
    flags: FlagSnapshot;
}
