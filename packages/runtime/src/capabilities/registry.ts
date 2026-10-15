/**
 * capabilities/registry.ts —— Skill 注册表：扫描 / 校验 / 不可变快照 / 查询
 * （docs/能力包规范.md §4/§5）。
 *
 * 扫描三级 skills 根下的 skill 目录（必须有 SKILL.md）；同名 id 只保留最高优先级，
 * 其余记入 shadowed()。非法 SKILL.md 不进快照、只进 errors()。
 */

import { join } from 'node:path';
import { SKILL_FILE, type SkillDocument, type SkillValidationIssue } from '@mazi/core';
import { buildSkillDocument } from './skill-md.js';
import {
    fileExists,
    listResourceFiles,
    listSkillDirNames,
    readTextFile,
    type SkillRoot,
    type SkillRootScope,
} from './source.js';

/** 单个 Skill 校验通过后的不可变快照。 */
export interface SkillSnapshot {
    document: SkillDocument;
    scope: SkillRootScope;
}

/** 被更高优先级同 id Skill 覆盖的记录。 */
export interface ShadowedSkill {
    skillId: string;
    dir: string;
    scope: SkillRootScope;
    shadowedBy: string;
}

/** 被拒绝加载的 Skill 及其机械校验错误。 */
export interface SkillLoadError {
    skillId: string;
    dir: string;
    scope: SkillRootScope;
    issues: readonly SkillValidationIssue[];
}

export interface SkillRegistryOptions {
    roots: readonly SkillRoot[];
}

function loadError(
    skillId: string,
    dir: string,
    scope: SkillRootScope,
    issues: SkillValidationIssue[],
): SkillLoadError {
    return { skillId, dir, scope, issues };
}

export class SkillRegistry {
    private constructor(
        readonly roots: readonly SkillRoot[],
        private readonly snapshots: readonly SkillSnapshot[],
        private readonly loadErrors: readonly SkillLoadError[],
        private readonly shadowedSkills: readonly ShadowedSkill[],
    ) {}

    static open(opts: SkillRegistryOptions): SkillRegistry {
        const snapshots: SkillSnapshot[] = [];
        const loadErrors: SkillLoadError[] = [];
        const shadowedSkills: ShadowedSkill[] = [];
        const byId = new Map<string, SkillSnapshot>();
        for (const root of opts.roots) {
            for (const dirName of listSkillDirNames(root.dir)) {
                const dir = join(root.dir, dirName);
                const path = join(dir, SKILL_FILE);
                if (!fileExists(path)) {
                    loadErrors.push(
                        loadError(dirName, dir, root.scope, [
                            {
                                code: 'skill.missing',
                                path,
                                message: '缺少 ' + SKILL_FILE,
                            },
                        ]),
                    );
                    continue;
                }
                let raw: string;
                try {
                    raw = readTextFile(path);
                } catch (error) {
                    loadErrors.push(
                        loadError(dirName, dir, root.scope, [
                            { code: 'skill.unreadable', path, message: String(error) },
                        ]),
                    );
                    continue;
                }
                const result = buildSkillDocument({
                    dir,
                    dirName,
                    path,
                    raw,
                    resources: listResourceFiles(dir, SKILL_FILE),
                });
                if (result.document === undefined) {
                    loadErrors.push(loadError(dirName, dir, root.scope, [...result.issues]));
                    continue;
                }
                const existing = byId.get(dirName);
                if (existing !== undefined) {
                    shadowedSkills.push({
                        skillId: dirName,
                        dir,
                        scope: root.scope,
                        shadowedBy: existing.document.dir,
                    });
                    continue;
                }
                const snapshot = Object.freeze({
                    document: Object.freeze({
                        ...result.document,
                        resources: Object.freeze([...result.document.resources]),
                    }),
                    scope: root.scope,
                });
                byId.set(dirName, snapshot);
                snapshots.push(snapshot);
            }
        }
        return new SkillRegistry(
            opts.roots,
            Object.freeze(snapshots),
            Object.freeze(loadErrors),
            Object.freeze(shadowedSkills),
        );
    }

    list(): readonly SkillSnapshot[] {
        return this.snapshots;
    }

    get(id: string): SkillSnapshot | undefined {
        return this.snapshots.find((snapshot) => snapshot.document.id === id);
    }

    has(id: string): boolean {
        return this.get(id) !== undefined;
    }

    errors(): readonly SkillLoadError[] {
        return this.loadErrors;
    }

    /** 被高优先级同 id Skill 覆盖的来源（UI 可提示「项目级覆盖了用户级」）。 */
    shadowed(): readonly ShadowedSkill[] {
        return this.shadowedSkills;
    }
}
