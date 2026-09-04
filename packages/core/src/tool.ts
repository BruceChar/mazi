import type { ToolSpec } from './capacity.js';
import type { ToolRequirement } from './turn-contract.js';

/** 工具注册表：将 TurnContract 的工具需求解析为 Capacity 白名单内的 ToolSpec */
export interface ToolRegistry {
    /**
     * 解析一组工具需求（按 name 或 capability）。
     * nameOrCapability 命中注册表内工具 name 视为精确匹配；
     * 命中 ToolSpec 能力关键词（如 'code-execution'）暂由注册表具体实现定义。
     */
    resolve(requirements: ToolRequirement[]): ToolResolution;
    /** 注册表内全部工具（已按 schema 校验） */
    list(): ToolSpec[];
}

/** 工具解析结果：白名单工具与缺失清单 */
export interface ToolResolution {
    tools: ToolSpec[];
    /** 声明 required=true 但缺失的工具名 */
    missingRequired: string[];
    /** 声明 required=false 但缺失的工具名 */
    missingOptional: string[];
}

/** 工具执行结果：统一成功/失败形状，禁止抛裸异常跨层 */
export type ToolExecutionResult =
    | { ok: true; content: string; data?: unknown }
    | { ok: false; error: string; retryable?: boolean };

/** 工具调用器：由运行时装配（name → 实现函数），Executor 只面向该接口 */
export interface ToolInvoker {
    /** 执行指定工具；未注册的工具视为 ok:false（retryable=false） */
    invoke(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
}
