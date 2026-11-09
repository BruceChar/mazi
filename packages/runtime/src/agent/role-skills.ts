/**
 * 角色技能解析：角色声明的是「附加技能」，与全局挂载取并集，只做加法。
 * 未声明（或声明为空）时返回 undefined，表示沿用全局挂载，行为与旧版一致。
 */
export function resolveRoleSkillIds(
    mounted: readonly string[],
    roleSkillIds?: readonly string[],
): readonly string[] | undefined {
    if (roleSkillIds === undefined || roleSkillIds.length === 0) return undefined;
    return [...new Set([...mounted, ...roleSkillIds])].sort();
}
