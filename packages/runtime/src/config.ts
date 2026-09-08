import type {
    FeatureFlagDefinition,
    PermissionLevel,
    SideEffectScope,
    ToolExecutionResult,
} from '@mazi/core';
import type { PricingSchedule } from '@mazi/provider-runtime';

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

/**
 * providers.json 条目（legacy 形态：driver 段为旧 pi-ai 声明）。
 * P2-3 起由运行时装配层翻译为新 provider-runtime §9.1 ProviderConfig；字段兼容旧配置文件。
 */
export interface ProviderConfig {
    id: string;
    vendor?: string;
    tags?: string[];
    models?: Array<{
        id: string;
        name?: string;
        contextWindow?: number;
        maxTokens?: number;
        supportsTools?: boolean;
        supportsThinking?: boolean;
        supportsVision?: boolean;
    }>;
    driver: {
        type: 'pi-ai';
        provider: string;
        model: string;
        apiKeyEnv?: string;
        baseUrl?: string;
    };
    pricing: PricingSchedule;
    health?: { score: number; lastErrorAt?: number };
    limits?: { rpm?: number; tpm?: number; concurrency?: number };
    specialties?: string[];
    costWeight?: number;
}

export interface RuntimeConfig {
    /** Provider JSON（driver.type=pi-ai，由 @mazi/provider 解释） */
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
        loopMode?: 'goal-plan-execute-reflect' | 'goal-plan-execute' | 'react-only';
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
