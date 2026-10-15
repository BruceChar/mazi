/**
 * 能力包（Capability Package / Skill）契约类型 —— docs/能力包规范.md §5–§6。
 *
 * 能力包是「manifest + 工具集 + 记忆 schema + 模板 + 校验器 + 事件」的声明式组合：
 * 不是独立 Agent，也不是写进核心的函数库。本文件只定义**声明契约**（数据形状 +
 * handler/validator 函数签名）；扫描、机械校验、快照与激活实现见 @mazi/runtime 的
 * `capabilities` 模块。
 */

import type { PermissionLevel, SideEffectScope } from './authz/permissions.js';

/** 能力包 id：kebab-case、全局唯一、与目录名一致。 */
export type SkillId = string;

/** 集合敏感度：secret 只写不读回（不注入 LLM 上下文）。 */
export type SkillSensitivity = 'normal' | 'sensitive' | 'secret';

export const SKILL_SENSITIVITIES: readonly SkillSensitivity[] = ['normal', 'sensitive', 'secret'];

/** 意图路由判据：复用问题分类法的 domain/category 闭集 + 关键词兜底。 */
export interface SkillIntents {
    domains: readonly string[];
    categories: readonly string[];
    keywords: readonly string[];
}

export interface SkillMemoryCollection {
    name: string;
    /** 缺省 normal；sensitive 需脱敏声明，secret 只写不读回。 */
    sensitivity?: SkillSensitivity;
}

export interface SkillEvents {
    emits: readonly string[];
    subscribes: readonly string[];
}

/** manifest.json —— 能力包唯一入口（注册表启动时扫描并校验）。 */
export interface SkillManifest {
    id: SkillId;
    /** semver；记忆 schema 演进时递增。 */
    version: string;
    name: string;
    description: string;
    intents: SkillIntents;
    /** 包内工具权限上限（PermissionLevel）；包内工具不得越界声明。 */
    permissionCeiling: PermissionLevel;
    /** 引用 tools/<name>.json。 */
    tools: readonly string[];
    memory: { collections: readonly SkillMemoryCollection[] };
    /** 引用 templates/<name>.md。 */
    templates: readonly string[];
    /** 引用 validators/<name>.ts。 */
    validators: readonly string[];
    events: SkillEvents;
    privacy?: { note?: string };
}

/**
 * 工具实现绑定。`module` 支持相对 skill 目录（`./handlers/diary.append.ts`）或裸模块
 * specifier；运行时按需 import()，不预打包进核心。`export` 缺省 'default'。
 */
export interface SkillHandlerRef {
    module: string;
    export?: string;
}

/** tools/<name>.json —— 声明复用运行时 ToolConfig 契约 + 实现绑定。 */
export interface SkillToolDeclaration {
    name: string;
    description: string;
    /** JSON Schema（core 保持 schema 无关，只约束为对象）。 */
    parameters: Record<string, unknown>;
    minPermission: PermissionLevel;
    sideEffects: readonly SideEffectScope[];
    irreversible?: boolean;
    handler: SkillHandlerRef;
    /** 引用 manifest.validators 中的名字；缺省 = 无校验。 */
    validators?: readonly string[];
}

/**
 * 本包记忆命名空间访问（skills.<skillId>.<collection>）：包间默认不可见。
 * `list` 对 secret 集合恒返回空（只写不读回）；是否注入 LLM 上下文由调用方按
 * sensitivity 决定，访问本身不构成注入授权。
 */
export interface SkillMemoryAccess {
    append(collection: string, record: Record<string, unknown>): Promise<void>;
    list(collection: string): Promise<readonly Record<string, unknown>[]>;
}

/** handler 调用上下文（归因 + 取消信号 + 本包记忆命名空间）。 */
export interface SkillHandlerContext {
    skillId: SkillId;
    tool: string;
    signal?: AbortSignal;
    /** 缺省 = 本次激活未挂载记忆命名空间（handler 不落库）。 */
    memory?: SkillMemoryAccess;
}

export type SkillToolHandler = (
    args: Record<string, unknown>,
    ctx: SkillHandlerContext,
) => Promise<unknown> | unknown;

/** 校验器输入：前置校验传 args；后置校验另带 value。 */
export interface SkillValidatorInput {
    skillId: SkillId;
    tool: string;
    args: Record<string, unknown>;
    value?: unknown;
}

/** 校验器输出：纯函数、确定性事实，不允许调用 LLM。 */
export interface SkillValidatorVerdict {
    ok: boolean;
    reason?: string;
}

export type SkillValidator = (input: SkillValidatorInput) => SkillValidatorVerdict;

/** capability.* 事件上携带 skillId 的属性键（HarnessEvent.attributes）。 */
export const SKILL_ID_ATTRIBUTE = 'harness.skill_id';

/** manifest/工具声明的机械校验错误码（注册表拒绝加载的依据）。 */
export type SkillValidationIssueCode =
    | 'manifest.missing'
    | 'manifest.unreadable'
    | 'manifest.not-object'
    | 'required.missing'
    | 'id.invalid'
    | 'id.mismatch'
    | 'version.invalid'
    | 'permission.ceiling-invalid'
    | 'intent.unknown'
    | 'tool.unresolvable'
    | 'tool.invalid'
    | 'tool.duplicate'
    | 'tool.permission-exceeds-ceiling'
    | 'memory.unresolvable'
    | 'memory.sensitivity-invalid'
    | 'template.unresolvable'
    | 'validator.unresolvable'
    | 'event.naming-invalid'
    | 'event.duplicate';

export interface SkillValidationIssue {
    code: SkillValidationIssueCode;
    /** 出错位置（如 `manifest.intents.domains[0]` / `tools/diary.append.json`）。 */
    path: string;
    message: string;
}
