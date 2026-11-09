import type { PermissionLevel, SideEffectScope } from '@mazi/core';
import type { AgentPromptOverrides } from './prompts/agent-prompts.js';
import type { PricingSchedule } from './provider/index.js';
import type { WikiRuntimeOptions } from './wiki/index.js';

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
    /**
     * “无结果”退出码：命中这些非零退出码时视为成功空结果（如 rg 无匹配 exit 1）。
     * 真实错误（如 rg 路径不存在 exit 2）仍返回 ok:false。
     */
    noMatchExitCodes?: readonly number[];
    /** “无结果”退出码对应的返回内容（缺省 '(no matches)'） */
    noMatchContent?: string;
    /**
     * 可选 glob 开关（如 fd 的 '--glob'）：当 `{pattern}` 参数含 glob 元字符（* ? [）且不是
     * 合法 regex 时，把该 flag 插到 pattern 参数之前，使 `*.md` 这类 glob 能被工具正确解析；
     * 合法 regex 仍按 regex 语义执行。
     */
    globFlag?: string;
    /**
     * 可选参数的缺省字面值（如 rg 的 path='.'）：args 模板中的可选占位符未提供时插入该值。
     * 用于避免 `rg <pattern>`（无 path）改为读取 stdin 而挂起/空结果。
     */
    argDefaults?: Record<string, string>;
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
        /** 厂商实际部署版本（如 DeepSeek-V4.1-Flash-1017）；id 仍为 API 调用名。 */
        modelVersion?: string;
        name?: string;
        contextWindow?: number;
        maxTokens?: number;
        supportsTools?: boolean;
        supportsThinking?: boolean;
        supportsVision?: boolean;
        /** 该模型专属价目（官网抓取写入；缺省用 provider 级 pricing）。 */
        pricing?: PricingSchedule;
    }>;
    driver: {
        type: 'pi-ai';
        provider: string;
        model: string;
        apiKeyEnv?: string;
        /**
         * 字面 API Key（由 secrets.json 注入；不落 providers.json）。
         * 存在时优先于 apiKeyEnv。
         */
        apiKey?: string;
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
    /** 用户行为流导出/迁移目录（缺省进程内存储；apps/api 通过 toRuntimeConfig 落到 MAZI_HOME/behavior） */
    behaviorDir?: string;
    /** 问题标签分类法注册表路径（缺省 MAZI_HOME/config/question-taxonomy.json，缺失用内置默认）。 */
    questionTaxonomyFile?: string;
    /** SQLite 文件路径（缺省内存库） */
    dbPath?: string;
    /** Goal 级选项（Goal 坐标系） */
    goal?: {
        permissionCeiling?: PermissionLevel;
        /** Task 允许的工具白名单（缺省 = 放行全部已配置工具；空数组 = 纯对话） */
        allowedTools?: string[];
    };
    systemPrompt?: string;
    /**
     * 各 Agent 的系统提示覆盖（settings.json 的 prompts 段；config 优先于内置默认）。
     * 空白/缺省 → 使用代码内置默认；保存后新会话生效。
     */
    agentPrompts?: AgentPromptOverrides;
    /** 命令分类规则文件路径；缺省 <MAZI_HOME>/config/auth/commands.json（MAZI_AUTH_CONFIG_DIR 可覆盖）。 */
    authCommandPolicyFile?: string;
    /** 模型上下文窗口（token），runtime 上下文计量与利用率用 */
    contextWindow?: number;
    /** token 估算编码（js-tiktoken，缺省 o200k_base；仅近似厂商 tokenizer） */
    tokenizerEncoding?: string;
    consoleEnabled?: boolean;
    /** 项目 wiki 开关与参数（settings.json 的 wiki 段；见 docs/项目wiki设计.md §12）。 */
    wiki?: WikiRuntimeOptions;
}
