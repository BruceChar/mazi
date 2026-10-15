/**
 * capabilities/template.ts —— markdown 提示模板渲染（{{var}} 占位）。
 *
 * 模板约束「模型怎么组织输出」，不写死业务规则；未知占位原样保留，避免静默吞掉数据缺口。
 */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function renderSkillTemplate(
    template: string,
    variables: Readonly<Record<string, unknown>>,
): string {
    return template.replace(PLACEHOLDER, (match, name: string) => {
        const value = variables[name];
        if (value === undefined || value === null) return match;
        return typeof value === 'string' ? value : JSON.stringify(value);
    });
}
