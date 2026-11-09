/**
 * Agent 角色表单的纯函数：草稿默认值、提交载荷归一化、模型选项与展示。
 * 与 Vue 组件解耦，便于单测覆盖（settings → Agent 角色管理）。
 */
export interface RoleFormState {
    roleId: string;
    label: string;
    description: string;
    modelId: string;
    tools: string;
    defaultCeiling: string;
    memoryPolicy: string;
    systemPrompt: string;
}

export interface RolePayload {
    roleId: string;
    label: string;
    description?: string;
    modelId?: string;
    tools: string[];
    defaultCeiling?: string;
    memoryPolicy?: 'inherit' | 'isolated';
    systemPrompt?: string;
}

export interface ProviderModel {
    id: string;
    modelVersion?: string;
    name?: string;
}

export interface ProviderGroup {
    id?: string;
    vendor?: string;
    models?: ProviderModel[];
}

export interface RoleLike {
    modelId?: string;
    defaultCeiling?: string;
    tools?: readonly string[];
    description?: string;
}

/** 新建角色的初始草稿：权限默认 read-only，模型留空表示跟随会话默认。 */
export function emptyRoleForm(): RoleFormState {
    return {
        roleId: '',
        label: '',
        description: '',
        modelId: '',
        tools: 'fs.read, rg',
        defaultCeiling: 'read-only',
        memoryPolicy: 'inherit',
        systemPrompt: '',
    };
}

/** 把已存在的角色读回草稿，供编辑复用。 */
export function roleToForm(role: {
    roleId: string;
    label: string;
    description?: string;
    modelId?: string;
    tools?: readonly string[];
    defaultCeiling?: string;
    memoryPolicy?: string;
    systemPrompt?: string;
}): RoleFormState {
    return {
        roleId: role.roleId,
        label: role.label,
        description: role.description ?? '',
        modelId: role.modelId ?? '',
        tools: (role.tools ?? []).join(', '),
        defaultCeiling: role.defaultCeiling ?? 'read-only',
        memoryPolicy: role.memoryPolicy === 'isolated' ? 'isolated' : 'inherit',
        systemPrompt: role.systemPrompt ?? '',
    };
}

/** 提交前归一化：去空白、工具逗号拆分、可选字段空值不下发。 */
export function buildRolePayload(form: RoleFormState): RolePayload {
    const tools = form.tools
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    return {
        roleId: form.roleId.trim(),
        label: form.label.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
        ...(form.modelId.trim() ? { modelId: form.modelId.trim() } : {}),
        tools,
        ...(form.defaultCeiling ? { defaultCeiling: form.defaultCeiling } : {}),
        memoryPolicy: form.memoryPolicy === 'isolated' ? 'isolated' : 'inherit',
        ...(form.systemPrompt.trim() ? { systemPrompt: form.systemPrompt.trim() } : {}),
    };
}

/** 角色表单的最小校验；返回错误文案，空串表示通过。 */
export function validateRolePayload(payload: RolePayload): string {
    if (!payload.roleId) return '角色 ID 必填';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(payload.roleId)) {
        return '角色 ID 只能用小写字母、数字和连字符';
    }
    if (!payload.label) return '显示名称必填';
    return '';
}

/** 模型下拉：第一项「跟随会话默认」，其余按 provider 分组平铺。 */
export function roleModelOptions(cfg: { providers?: ProviderGroup[] } | null): Array<{
    value: string;
    label: string;
    group: string;
}> {
    const options: Array<{ value: string; label: string; group: string }> = [];
    for (const provider of cfg?.providers ?? []) {
        const group = provider.vendor || provider.id || 'provider';
        for (const model of provider.models ?? []) {
            options.push({
                value: model.id,
                label: model.modelVersion || model.name || model.id,
                group,
            });
        }
    }
    return options;
}

/** 卡片上展示的模型名；未指定模型时明确写成「跟随会话默认」。 */
export function roleModelLabel(cfg: { providers?: ProviderGroup[] } | null, modelId?: string): string {
    if (!modelId) return '跟随会话默认';
    for (const provider of cfg?.providers ?? []) {
        const model = (provider.models ?? []).find((item) => item.id === modelId);
        if (model) return model.modelVersion || model.name || model.id;
    }
    return modelId;
}

/** 卡片一行说明：优先 description，缺失时回退到权限与工具摘要。 */
export function roleSummary(role: RoleLike): string {
    if (role.description) return role.description;
    const tools = role.tools ?? [];
    return `${role.defaultCeiling ?? 'inherit'} · ${tools.length} 个工具`;
}
