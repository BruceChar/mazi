import type { PermissionLevel, SideEffectScope } from '@mazi/core';
import type { PricingSchedule } from './provider/index.js';

/** 工具实现结果（goal 路径执行器消费；与 core ToolExecutionResult 解耦） */
export interface ToolCallResult {
    ok: boolean;
    content?: unknown;
    error?: string;
    retryable?: boolean;
}

/** CLI 命令工具规格：由运行时在 workspace 内以 argv 执行（不经 shell，防注入） */
export interface CliCommandSpec {
    /** 可执行名（PATH 内，如 rg/fd/bat/eza/dua/difft/xh/sd/sg） */
    bin: string;
    /** argv 模板：字面 flag 原样；占位符 key 取自模型 args。 */
    args: string[];
    /** 超时（默认 30s） */
    timeoutMs?: number;
    /** 输出上限字符（默认 40000，超出截断） */
    maxOutputChars?: number;
    /** 包管理器包名（命令缺失时自动安装用；如 rg→ripgrep、dua→dua-cli、sg→ast-grep） */
    installPackage?: string;
    /** 指定包管理器（缺省按平台探测：macOS brew / Linux apt-get|dnf|apk） */
    installManager?: 'brew' | 'apt' | 'dnf' | 'apk';
}

/** 工具配置：spec（schema/白名单）+ 可选实现 */
export interface ToolConfig {
    name: string;
    description: string;
    parameters: unknown;
    minPermission: PermissionLevel;
    irreversible?: boolean;
    sideEffects: SideEffectScope[];
    /** 缺省实现：仅内置 fs.read（只读 utf8）；其余缺实现 → 调用返回 ok:false */
    impl?: (args: Record<string, unknown>) => Promise<ToolCallResult>;
    /** CLI 命令工具（内置通用执行器在 workspace 内运行；提供该字段则无需 impl） */
    command?: CliCommandSpec;
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
    /** 事件 JSONL 目录（默认 $EVENT_LOG_DIR 或 ./events） */
    eventDir?: string;
    /** SQLite 文件路径（缺省内存库） */
    dbPath?: string;
    /** Goal 级选项（Goal 坐标系） */
    goal?: {
        permissionCeiling?: PermissionLevel;
        /** Task 允许的工具白名单（缺省 = 放行全部已配置工具；空数组 = 纯对话） */
        allowedTools?: string[];
    };
    systemPrompt?: string;
    /** 模型上下文窗口（token），runtime 上下文计量与利用率用 */
    contextWindow?: number;
    /** token 估算编码（js-tiktoken，缺省 o200k_base；仅近似厂商 tokenizer） */
    tokenizerEncoding?: string;
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
