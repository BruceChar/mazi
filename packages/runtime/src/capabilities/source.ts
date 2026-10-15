/**
 * capabilities/source.ts —— skills 根装配、声明文件读取与模块加载。
 *
 * skills 是**用户资产**，不在代码仓库里（docs/能力包规范.md §1/§4）：
 * - 项目级：`<workspace>/skills/`（优先级更高，同名覆盖用户级）
 * - 用户级：`$MAZI_HOME/skills/`
 * 能力包一律声明式优先；handler/validator 通过**相对 skill 目录**的 specifier 按需
 * import()，不预打包进核心（AGENT.md 核心最小原则）。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type SkillRootScope = 'project' | 'user';

/** 一个 skills 根目录及其作用域。 */
export interface SkillRoot {
    dir: string;
    scope: SkillRootScope;
}

export interface SkillRootsInput {
    /** MAZI_HOME。 */
    home: string;
    /** 当前项目工作区（缺省 = 仅用户级）。 */
    workspace?: string;
}

export function asSkillRoot(dir: string, scope: SkillRootScope = 'user'): SkillRoot {
    return { dir: resolve(dir), scope };
}

/** 根装配：项目级在前（同名覆盖用户级），去重。 */
export function skillRoots(input: SkillRootsInput): readonly SkillRoot[] {
    const roots: SkillRoot[] = [];
    if (input.workspace !== undefined && input.workspace.trim().length > 0) {
        roots.push({ dir: join(resolve(input.workspace), 'skills'), scope: 'project' });
    }
    roots.push({ dir: join(resolve(input.home), 'skills'), scope: 'user' });
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
