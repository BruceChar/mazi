/**
 * Skill（SKILL.md）契约类型 —— 对齐 Agent Skills 开放标准，规范见 docs/能力包规范.md §1–§3。
 *
 * 一个 Skill 的最小完整形态 = 一个目录 + 一个 `SKILL.md`：
 * frontmatter（name / description …）+ Markdown 正文；可选随包文件按相对路径引用。
 * Skill **不注册工具、不声明权限、不拥有数据集合**——那是插件 / MCP 的职责。
 */

/** Skill id：目录名（kebab-case 约定，全局唯一，同级根内不重复）。 */
export type SkillId = string;

/** 规范文件名。 */
export const SKILL_FILE = 'SKILL.md';

/** capability.* 事件上携带 skillId 的属性键（HarnessEvent.attributes）。 */
export const SKILL_ID_ATTRIBUTE = 'harness.skill_id';

/** YAML frontmatter（标准字段 + 常见扩展；未知字段保留在 metadata）。 */
export interface SkillFrontmatter {
    /** 缺省 = 目录名。 */
    name: string;
    /** 做什么 + 什么时候用（模型据此决定是否加载）。 */
    description: string;
    /** 触发语 / 示例请求。 */
    whenToUse?: string;
    /** Claude Code 扩展字段：允许的工具；mazi 解析并展示，暂不参与判权。 */
    allowedTools?: readonly string[];
    license?: string;
    /** 其余未知字段（原样保留展示）。 */
    metadata: Readonly<Record<string, string | readonly string[]>>;
}

/** 一个 Skill 的文档视图（解析后）。 */
export interface SkillDocument {
    /** 目录名（稳定标识）。 */
    id: SkillId;
    name: string;
    description: string;
    /** Markdown 正文（frontmatter 之后的内容）。 */
    body: string;
    frontmatter: SkillFrontmatter;
    /** SKILL.md 绝对路径（catalog 里给模型按需读取）。 */
    path: string;
    /** Skill 目录绝对路径。 */
    dir: string;
    /** 除 SKILL.md 之外的随包文件（相对路径，排序）。 */
    resources: readonly string[];
    /** SKILL.md 字节数。 */
    bytes: number;
}

/** 机械校验错误码（不合格即拒绝加载）。 */
export type SkillIssueCode =
    | 'skill.missing'
    | 'skill.unreadable'
    | 'frontmatter.missing'
    | 'frontmatter.invalid'
    | 'description.missing'
    | 'body.empty';

export interface SkillValidationIssue {
    code: SkillIssueCode;
    path: string;
    message: string;
}
