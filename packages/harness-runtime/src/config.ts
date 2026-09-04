import type {
    FeatureFlagDefinition,
    PermissionLevel,
    SideEffectScope,
    ToolExecutionResult,
} from '@mazi/core';
import type { ProviderJson } from '@mazi/provider-llm';

/** 工具配置：spec（写库/白名单）+ 可选实现（缺省时仅内置 fs.read 可用） */
export interface ToolConfig {
    name: string;
    description: string;
    parameters: unknown;
    minPermission: PermissionLevel;
    irreversible?: boolean;
    sideEffects: SideEffectScope[];
    /** 缺省实现：仅内置 fs.read（只读 utf8）；其余缺实现 → 调用返回 ok:false */
    impl?: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

/** providers.json 条目：core Provider 的 JSON 输入 */
export type ProviderConfig = ProviderJson;

export interface RuntimeConfig {
    /** Provider JSON（driver.type=scripted 等，由 provider-llm 解释） */
    providers: ProviderConfig[];
    tools: ToolConfig[];
    /** 追加/覆盖默认 Flag（按 key） */
    flags?: FeatureFlagDefinition[];
    /** 事件 JSONL 目录（默认 $EVENT_LOG_DIR 或 ./events） */
    eventDir?: string;
    /** SQLite 文件路径（缺省内存库） */
    dbPath?: string;
    /** Goal 级选项 */
    goal?: {
        permissionCeiling?: PermissionLevel;
        allowedTools?: string[];
        requiredTools?: { nameOrCapability: string; required: boolean }[];
        maxSteps?: number;
        maxCostUsd?: number;
        successConditions?: string[];
    };
    systemPrompt?: string;
    contextWindow?: number;
    consoleEnabled?: boolean;
}

export interface ToolSpecLike {
    name: string;
    description: string;
    parameters: unknown;
    minPermission: PermissionLevel;
    irreversible?: boolean;
    sideEffects: SideEffectScope[];
}
