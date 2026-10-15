/**
 * capabilities/scaffold.ts —— 新建技能：写入最小可校验的 manifest 脚手架
 * （docs/能力包规范.md §4/§10/CP-11）。
 *
 * 新建让「发现 → 挂载」在 UI 里闭环：脚手架只写 manifest.json + README.md，
 * 保持零工具、零记忆、read-only 上限（安全默认）；工具/模板/校验器由作者按 §4 追加。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionLevel, SkillIntents, SkillManifest } from '@mazi/core';
import type { SkillRoot, WritableSkillRootScope } from './source.js';

export const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MANIFEST_FILE = 'manifest.json';
export const SKILL_README_FILE = 'README.md';

export interface SkillScaffoldInput {
    id: string;
    name: string;
    description?: string;
    intents?: Partial<SkillIntents>;
    permissionCeiling?: PermissionLevel;
}

export interface SkillScaffoldResult {
    dir: string;
    manifest: SkillManifest;
}

/** 某作用域对应的可写根（builtin 只读 → undefined）。 */
export function scaffoldRootOf(
    roots: readonly SkillRoot[],
    scope: WritableSkillRootScope,
): SkillRoot | undefined {
    return roots.find((root) => root.scope === scope);
}

function readmeOf(manifest: SkillManifest): string {
    return [
        '# ' + manifest.name + '（' + manifest.id + '）',
        '',
        '> 由 mazi 技能面板生成的脚手架；规范见 docs/能力包规范.md。',
        '',
        '## 领域边界',
        '',
        '- **做**：' + manifest.description,
        '- **不做**：（补充：本技能明确不负责的事情）',
        '',
        '## 工具',
        '',
        '当前还没有工具。新增步骤：',
        '',
        '1. 在 `tools/<tool>.json` 声明工具（复用 ToolConfig 契约 + `handler: { module, export }`）；',
        '2. 在 `handlers/` 实现 handler（导出函数，接收 args 与 ctx，ctx.memory 写本包命名空间）；',
        '3. 在 `manifest.json` 的 `tools` 中加入工具名。',
        '4. 需要校验时写 `validators/<name>.ts`（默认导出纯函数），并在工具声明里引用。',
        '',
        '## 数据语义（memory）',
        '',
        '当前没有集合。集合 schema 放 `memory/schemas.json`，并在 manifest.memory.collections 声明敏感度；',
        '`sensitive` 默认不注入 LLM 上下文，`secret` 只写不读回。',
        '',
        '## 提醒规则示例',
        '',
        '领域事件命名遵循 `skill.' + manifest.id + '.<name>`；调度与投递属平台职责（CP-D）。',
        '',
        '## 版本与迁移',
        '',
        '- 当前版本 ' + manifest.version + '；记忆 schema 演进时递增 minor 并在此声明迁移策略。',
        '',
    ].join('\n');
}

/** 在指定根下创建技能目录；目录已存在 / id 非法 / 名称为空 → 抛错（不覆盖用户资产）。 */
export function scaffoldSkill(root: SkillRoot, input: SkillScaffoldInput): SkillScaffoldResult {
    if (root.scope === 'builtin') throw new Error('内置技能根只读，不支持新建');
    const id = input.id.trim();
    if (!SKILL_ID_PATTERN.test(id)) {
        throw new Error('技能 id 必须是 kebab-case（小写字母/数字/连字符）：' + id);
    }
    const name = input.name.trim();
    if (name.length === 0) throw new Error('技能名称不能为空');
    const dir = join(root.dir, id);
    if (existsSync(dir)) throw new Error('技能目录已存在：' + dir);
    const manifest: SkillManifest = {
        id,
        version: '0.1.0',
        name,
        description: input.description?.trim() || name,
        intents: {
            domains: input.intents?.domains ?? [],
            categories: input.intents?.categories ?? [],
            keywords: input.intents?.keywords ?? [],
        },
        permissionCeiling: input.permissionCeiling ?? 'read-only',
        tools: [],
        memory: { collections: [] },
        templates: [],
        validators: [],
        events: { emits: [], subscribes: [] },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    writeFileSync(join(dir, SKILL_README_FILE), readmeOf(manifest), 'utf8');
    return { dir, manifest };
}
