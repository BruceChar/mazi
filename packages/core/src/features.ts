/**
 * Feature（特性开关）契约 —— docs/AB测试设计.md §3。
 *
 * Feature 是用户可编辑的**声明式运行配置开关**：开启后只做三件事——
 * 追加系统提示片段、调整 Skill 目录集合、**收窄**工具白名单。
 *
 * 不变量：Feature 不注册工具、不放宽权限、不改 permissionCeiling；
 * 它只能收窄工具面（见 resolveFeatures.allowedTools 语义）。因此 Feature
 * 永远不会成为第二套权限面，也无法绕过 Goal ceiling + authz。
 */

/** Skill 集合处理方式：add = 叠加到全局挂载；only = 独占本次运行的技能集合。 */
export type FeatureSkillMode = 'add' | 'only';

/**
 * Feature 定义（持久化于 $MAZI_HOME/features.json 的一条声明）。
 * 字段除 id/name/description/enabled 外全部可选：未声明的维度不参与运行覆盖。
 */
export interface FeatureDefinition {
    id: string;
    name: string;
    description: string;
    /** 默认开关；运行期可被 override 覆盖（不修改定义本身）。 */
    enabled: boolean;
    /** 开启后追加到系统提示末尾的指令片段。 */
    promptFragment?: string;
    /** 开启后参与 / 限定的 Skill id。 */
    skills?: readonly string[];
    /** skills 的处理方式；缺省 'add'（仅当 skills 非空时生效）。 */
    skillMode?: FeatureSkillMode;
    /** 开启后收窄本次运行可见的工具（与配置白名单取交集，永不放宽）。 */
    allowedTools?: readonly string[];
    /** 开启后作为本次运行的默认推理强度（显式 reasoningLevel 优先）。 */
    reasoningLevel?: string;
    createdAt?: number;
    updatedAt?: number;
}

/** 单个 Feature 的求值痕迹（复盘用：值从哪来）。 */
export interface FeatureResolutionStep {
    id: string;
    enabled: boolean;
    source: 'default' | 'override';
}

/** 一次运行的有效 Feature 集合（run 边界冻结，写入 flag.evaluated 审计）。 */
export interface EffectiveFeatures {
    /** 每个已知 Feature 的有效开关（未知 id 的 override 不参与）。 */
    values: Record<string, boolean>;
    /** 求值痕迹，按 id 升序，与 values 一一对应。 */
    trace: FeatureResolutionStep[];
    /** 开启的 Feature id（按 id 升序）。 */
    enabledIds: string[];
    /** 各开启 Feature 的 promptFragment 以空行拼接（无则空串）。 */
    promptFragment: string;
    /** 开启 Feature 声明的 Skill id 并集（按 id 升序）。 */
    skillIds: string[];
    /** only = 独占 skillIds；add = 叠加到全局挂载；inherit = 不影响技能集合。 */
    skillMode: FeatureSkillMode | 'inherit';
    /** 所有声明 allowedTools 的开启 Feature 的交集；无声明则 undefined（= 不额外收窄）。 */
    allowedTools?: string[];
    /** 第一个（按 id 升序）声明 reasoningLevel 的开启 Feature 的取值。 */
    reasoningLevel?: string;
}

/** Feature id 规范：kebab-case（小写字母 / 数字，连字符分隔）。 */
export const FEATURE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidFeatureId(id: string): boolean {
    return FEATURE_ID_PATTERN.test(id);
}

function compareById(a: { id: string }, b: { id: string }): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 解析一次运行的有效 Feature：全局默认 + 运行期 override。
 *
 * 纯函数（F-4）：不读文件、不写时间；同输入必同输出（按 id 升序求值，
 * 与 definitions 的传入顺序无关），使实验可复现。
 */
export function resolveFeatures(
    definitions: readonly FeatureDefinition[],
    overrides: Readonly<Record<string, boolean>> = {},
): EffectiveFeatures {
    const values: Record<string, boolean> = {};
    const trace: FeatureResolutionStep[] = [];
    const enabledIds: string[] = [];
    const fragments: string[] = [];
    const skillIds = new Set<string>();
    let skillMode: FeatureSkillMode | 'inherit' = 'inherit';
    let allowedTools: Set<string> | undefined;
    let reasoningLevel: string | undefined;

    for (const definition of [...definitions].sort(compareById)) {
        const override = overrides[definition.id];
        const enabled = override ?? definition.enabled;
        values[definition.id] = enabled;
        trace.push({
            id: definition.id,
            enabled,
            source: override === undefined ? 'default' : 'override',
        });
        if (!enabled) continue;
        enabledIds.push(definition.id);
        const fragment = definition.promptFragment?.trim() ?? '';
        if (fragment.length > 0) fragments.push(fragment);
        if (definition.skillMode === 'only') {
            skillMode = 'only';
        } else if (skillMode !== 'only' && (definition.skills?.length ?? 0) > 0) {
            skillMode = 'add';
        }
        for (const skillId of definition.skills ?? []) skillIds.add(skillId);
        if (definition.allowedTools !== undefined) {
            const declared = new Set(definition.allowedTools);
            allowedTools =
                allowedTools === undefined
                    ? declared
                    : new Set([...allowedTools].filter((name) => declared.has(name)));
        }
        if (reasoningLevel === undefined && definition.reasoningLevel !== undefined) {
            reasoningLevel = definition.reasoningLevel;
        }
    }

    const effective: EffectiveFeatures = {
        values,
        trace,
        enabledIds,
        promptFragment: fragments.join('\n\n'),
        skillIds: [...skillIds].sort(),
        skillMode,
    };
    if (allowedTools !== undefined) effective.allowedTools = [...allowedTools].sort();
    if (reasoningLevel !== undefined) effective.reasoningLevel = reasoningLevel;
    return effective;
}
