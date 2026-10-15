/**
 * capabilities/source.ts —— skills 根装配、声明文件读取与模块加载。
 *
 * 三级 skills 根（docs/能力包规范.md §1/§4/§7.1），优先级降序：
 * - 项目级：`<workspace>/skills/`（用户/项目资产，可写）
 * - 用户级：`$MAZI_HOME/skills/`（用户资产，可写；UI「新建技能」默认落点）
 * - 内置级：`<runtime>/builtin-skills/`（随应用分发、只读；MAZI_BUILTIN_SKILLS_DIR 可覆盖）
 * 同名 id 只保留最高优先级那份。能力包一律声明式优先；handler/validator 通过
 * **相对 skill 目录**的 specifier 按需 import()，不预打包进核心（AGENT.md 核心最小原则）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** 内置技能落点：随 runtime 分发（可被 MAZI_BUILTIN_SKILLS_DIR 覆盖）。 */
export function defaultBuiltinSkillsRoot(): string {
    const override = process.env.MAZI_BUILTIN_SKILLS_DIR;
    if (override !== undefined && override.trim().length > 0) return resolve(override);
    // src/capabilities/source.ts 与 dist/capabilities/source.js 均上溯两级到 runtime 包根。
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

export type ReadJsonResult =
    | { ok: true; value: unknown }
    | { ok: false; missing: boolean; error: string };

export function readJsonFile(path: string): ReadJsonResult {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (error) {
        return { ok: false, missing: true, error: String(error) };
    }
    try {
        return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (error) {
        return { ok: false, missing: false, error: String(error) };
    }
}

export function readTextFile(path: string): string {
    return readFileSync(path, 'utf8');
}

export function listFileNames(dir: string, extensions: readonly string[]): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
        .map((entry) => entry.name)
        .sort();
}

/** 去掉扩展名（validators/entry.ts → entry）。 */
export function stripExtension(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    return dot <= 0 ? fileName : fileName.slice(0, dot);
}

/** 模块引用：相对 specifier 按 skill 目录解析。 */
export interface SkillModuleRef {
    skillId: string;
    skillDir: string;
    module: string;
    export?: string;
}

export type SkillModuleLoader = (ref: SkillModuleRef) => Promise<unknown>;

/** 默认加载器：'./x.ts' 相对 skill 目录；裸 specifier 交给 Node 解析。 */
export const fileModuleLoader: SkillModuleLoader = async (ref) => {
    const specifier = ref.module.startsWith('.')
        ? pathToFileURL(resolve(ref.skillDir, ref.module)).href
        : ref.module;
    const loaded = (await import(specifier)) as Record<string, unknown>;
    const exportName = ref.export ?? 'default';
    const value = loaded[exportName];
    if (value === undefined) {
        throw new Error(`能力包 ${ref.skillId} 的模块 ${ref.module} 未导出 ${exportName}`);
    }
    return value;
};
