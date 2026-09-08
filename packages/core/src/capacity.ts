import type { PermissionLevel, SideEffectScope } from './authorization.js';
import type { FlagSnapshot } from './flags.js';

// PermissionLevel / SideEffectScope 的唯一规范来源是 authorization.ts（授权族词汇表），
// 本模块只消费并转发（保持既有 '@mazi/core' 公开导出面不变，避免同名类型双份）。
export type { PermissionLevel, SideEffectScope };

// ============================================================
// 迁移期 legacy 类型（随 provider 契约切换保留，供旧 Session/Turn/Step 层引用；
// harness 执行层迁移到 LLMProvider 后移除）。规范类型见 provider.ts。
// ============================================================

/** 模型引用（legacy：旧执行层模型归属标记；provider-core 以 modelId 字符串表达） */
export interface ModelRef {
    providerId: string;
    vendor: string;
    modelId: string;
}

/** 工具参数 JSON-Schema（legacy 形态；provider-core 用 ToolSchema.parameters 表达） */
export type JSONSchemaSpec = Record<string, unknown>;

/** 硬能力路由标签（legacy：随 planner 路由迁移到 provider-runtime 后移除） */
export type CapabilityTag = 'tools' | 'vision' | 'thinking' | 'long-context';

/** 业务专长路由标签（legacy：同 CapabilityTag） */
export type SpecialtyTag = 'code-refactoring' | 'data-analysis' | 'summarization' | (string & {});

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
