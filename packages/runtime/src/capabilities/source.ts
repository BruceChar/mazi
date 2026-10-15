/**
 * capabilities/source.ts —— 三级 skills 根装配与文件读取（docs/能力包规范.md §4）。
 *
 * 优先级降序：项目级 workspace/skills（可写）> 用户级 MAZI_HOME/skills（可写）
 * > 内置级 runtime/builtin-skills（随应用分发、只读；MAZI_BUILTIN_SKILLS_DIR 可覆盖）。
 * 同名 id 只保留最高优先级那份；扫描单位是 skill 目录下的 SKILL.md。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillRootScope = 'project' | 'user' | 'builtin';

/** 可写作用域（内置根只读）。 */
export type WritableSkillRootScope = Exclude<SkillRootScope, 'builtin'>;

/** 一个 skills 根目录及其作用域。 */
export interface SkillRoot {
    dir: string;
    scope: SkillRootScope;
}

export interface SkillRootsInput {
    /** MAZI_HOME。 */
    home: string;
    /** 当前项目工作区（缺省 = 不含项目级）。 */
    workspace?: string;
    /** 内置根；缺省 = defaultBuiltinSkillsRoot()，显式传 null 表示不含内置级。 */
    builtin?: string | null;
}

export function asSkillRoot(dir: string, scope: SkillRootScope = 'user'): SkillRoot {
    return { dir: resolve(dir), scope };
}

/** 内置 Skill 落点：随 runtime 分发（可被 MAZI_BUILTIN_SKILLS_DIR 覆盖）。 */
export function defaultBuiltinSkillsRoot(): string {
    const override = process.env.MAZI_BUILTIN_SKILLS_DIR;
    if (override !== undefined && override.trim().length > 0) return resolve(override);
    // 源码与产物目录均上溯两级到 runtime 包根。
    return fileURLToPath(new URL('../../builtin-skills', import.meta.url));
}

/** 根装配：项目 → 用户 → 内置（同名高优先级覆盖低优先级），去重。 */
export function skillRoots(input: SkillRootsInput): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    if (input.workspace !== undefined && input.workspace.trim().length > 0) {
        roots.push({ dir: join(resolve(input.workspace), 'skills'), scope: 'project' });
    }
    roots.push({ dir: join(resolve(input.home), 'skills'), scope: 'user' });
    const builtin =
        input.builtin === null ? undefined : (input.builtin ?? defaultBuiltinSkillsRoot());
    if (builtin !== undefined) roots.push({ dir: resolve(builtin), scope: 'builtin' });
    const seen = new Set<string>();
    return roots.filter((root) => {
        if (seen.has(root.dir)) return false;
        seen.add(root.dir);
        return true;
    });
}

/** skill 目录名（注册表扫描单位）。 */
export function listSkillDirNames(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

export function readTextFile(path: string): string {
    return readFileSync(path, 'utf8');
}

export function fileExists(path: string): boolean {
    return existsSync(path);
}

/** Skill 目录内的随包文件（相对路径，排除 SKILL.md，排序）。 */
export function listResourceFiles(dir: string, skillFileName: string): string[] {
    const found: string[] = [];
    const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const rel = relative(dir, full);
            if (rel === skillFileName) continue;
            found.push(rel);
        }
    };
    if (existsSync(dir)) walk(dir);
    return found.sort();
}
