/**
 * capabilities/registry.ts —— 能力注册表：扫描 / 校验 / 不可变快照 / 查询（docs/能力包规范.md §7.1）。
 *
 * 扫描 skills 根（项目级在前、用户级在后）；同名 id 以 project 覆盖 user（记入 shadowed()）。
 * 命名区分：apps/api 的 catalog 是**模型目录与计费**；能力注册表是独立模块，接口前缀
 * /api/capabilities，不复用 catalog。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
    SkillId,
    SkillManifest,
    SkillToolDeclaration,
    SkillValidationIssue,
} from '@mazi/core';
import type { QuestionTaxonomy } from '@mazi/libs';
import { DEFAULT_QUESTION_TAXONOMY } from '../question/taxonomy.js';
import { type SkillIntentMatch, type SkillIntentQuery, scoreSkillIntent } from './intent.js';
import { type SkillResourceIndex, validateSkillManifest } from './manifest.js';
import {
    fileModuleLoader,
    listFileNames,
    listSkillDirNames,
    readJsonFile,
    readTextFile,
    type SkillModuleLoader,
    type SkillRoot,
    type SkillRootScope,
    stripExtension,
} from './source.js';

/** 单个能力包校验通过后的不可变快照。 */
export interface SkillSnapshot {
    manifest: SkillManifest;
    /** skill 目录绝对路径。 */
    dir: string;
    /** 来源作用域：project（项目级）覆盖 user（用户级）。 */
    scope: SkillRootScope;
    tools: readonly SkillToolDeclaration[];
    templates: ReadonlyMap<string, string>;
    /** validator 名 → 相对模块 specifier。 */
    validators: ReadonlyMap<string, string>;
    memorySchemas: ReadonlyMap<string, Record<string, unknown>>;
    /** events.ts 的相对 specifier（存在时）。 */
    eventsModule?: string;
}

/** 被更高优先级同 id 包覆盖的记录。 */
export interface ShadowedSkill {
    skillId: string;
    dir: string;
    scope: SkillRootScope;
    shadowedBy: string;
}

/** 被拒绝加载的能力包及其机械校验错误。 */
export interface SkillLoadError {
    skillId: string;
    /** 出错来源目录（定位用户/项目配置问题）。 */
    dir: string;
    scope: SkillRootScope;
    issues: readonly SkillValidationIssue[];
}

export interface CapabilityRegistryOptions {
    /** skills 根（建议由 skillRoots() 装配：project 在前）。 */
    roots: readonly SkillRoot[];
    taxonomy?: QuestionTaxonomy;
    loadModule?: SkillModuleLoader;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readResources(dir: string): SkillResourceIndex {
    const toolsDir = join(dir, 'tools');
    const toolDeclarations = listFileNames(toolsDir, ['.json']).map((file) => {
        const read = readJsonFile(join(toolsDir, file));
        return { file: 'tools/' + file, value: read.ok ? read.value : undefined };
    });
    const validators = new Map<string, string>();
    for (const file of listFileNames(join(dir, 'validators'), ['.ts', '.js', '.mjs'])) {
        validators.set(stripExtension(file), './validators/' + file);
    }
    const templateContents = new Map<string, string>();
    for (const file of listFileNames(join(dir, 'templates'), ['.md'])) {
        templateContents.set(stripExtension(file), readTextFile(join(dir, 'templates', file)));
    }
    const memoryRead = readJsonFile(join(dir, 'memory', 'schemas.json'));
    const memoryCollections =
        memoryRead.ok && isRecord(memoryRead.value) ? Object.keys(memoryRead.value) : [];
    const eventsPath = join(dir, 'events.ts');
    return {
        toolDeclarations,
        templateContents,
        validators,
        memoryCollections,
        ...(existsSync(eventsPath) ? { eventsModule: './events.ts' } : {}),
    };
}

function readMemorySchemas(dir: string): Map<string, Record<string, unknown>> {
    const schemas = new Map<string, Record<string, unknown>>();
    const read = readJsonFile(join(dir, 'memory', 'schemas.json'));
    if (!read.ok || !isRecord(read.value)) return schemas;
    for (const [name, schema] of Object.entries(read.value)) {
        if (isRecord(schema)) schemas.set(name, schema);
    }
    return schemas;
}

function buildSnapshot(
    dir: string,
    scope: SkillRootScope,
    manifest: SkillManifest,
    tools: readonly SkillToolDeclaration[],
    resources: SkillResourceIndex,
): SkillSnapshot {
    return Object.freeze({
        manifest: Object.freeze({
            ...manifest,
            intents: Object.freeze({ ...manifest.intents }),
            memory: Object.freeze({ collections: Object.freeze([...manifest.memory.collections]) }),
            events: Object.freeze({
                emits: Object.freeze([...manifest.events.emits]),
                subscribes: Object.freeze([...manifest.events.subscribes]),
            }),
        }),
        dir,
        scope,
        tools: Object.freeze(tools.map((tool) => Object.freeze({ ...tool }))),
        templates: new Map(resources.templateContents),
        validators: new Map(resources.validators),
        memorySchemas: readMemorySchemas(dir),
        ...(resources.eventsModule !== undefined ? { eventsModule: resources.eventsModule } : {}),
    });
}

/**
 * 能力注册表：扫描 skills 根下的 <id>/manifest.json，机械校验后构建不可变快照。
 * 非法 manifest 不进快照、只进 errors()（CP-1）；跨包工具名冲突后到者被拒绝。
 */
export class CapabilityRegistry {
    private constructor(
        readonly roots: readonly SkillRoot[],
        readonly taxonomy: QuestionTaxonomy,
        readonly loadModule: SkillModuleLoader,
        private readonly snapshots: readonly SkillSnapshot[],
        private readonly loadErrors: readonly SkillLoadError[],
        private readonly shadowedSkills: readonly ShadowedSkill[],
    ) {}

    static open(opts: CapabilityRegistryOptions): CapabilityRegistry {
        const taxonomy = opts.taxonomy ?? DEFAULT_QUESTION_TAXONOMY;
        const loadModule = opts.loadModule ?? fileModuleLoader;
        const snapshots: SkillSnapshot[] = [];
        const loadErrors: SkillLoadError[] = [];
        const shadowedSkills: ShadowedSkill[] = [];
        const byId = new Map<string, SkillSnapshot>();
        const toolOwners = new Map<string, string>();
        for (const root of opts.roots) {
            if (!existsSync(root.dir)) continue;
            for (const dirName of listSkillDirNames(root.dir)) {
                const dir = join(root.dir, dirName);
                const manifestRead = readJsonFile(join(dir, 'manifest.json'));
                if (!manifestRead.ok) {
                    loadErrors.push({
                        skillId: dirName,
                        dir,
                        scope: root.scope,
                        issues: [
                            {
                                code: 'manifest.missing',
                                path: 'manifest.json',
                                message: manifestRead.error,
                            },
                        ],
                    });
                    continue;
                }
                const resources = readResources(dir);
                const result = validateSkillManifest({
                    raw: manifestRead.value,
                    dirName,
                    taxonomy,
                    resources,
                });
                if (!result.ok || result.manifest === undefined) {
                    loadErrors.push({
                        skillId: dirName,
                        dir,
                        scope: root.scope,
                        issues: result.issues,
                    });
                    continue;
                }
                const existing = byId.get(result.manifest.id);
                if (existing !== undefined) {
                    shadowedSkills.push({
                        skillId: result.manifest.id,
                        dir,
                        scope: root.scope,
                        shadowedBy: existing.dir,
                    });
                    continue;
                }
                const conflicts = result.tools.filter((tool) => toolOwners.has(tool.name));
                if (conflicts.length > 0) {
                    loadErrors.push({
                        skillId: dirName,
                        dir,
                        scope: root.scope,
                        issues: conflicts.map((tool) => ({
                            code: 'tool.duplicate' as const,
                            path: 'tools/' + tool.name + '.json',
                            message:
                                '跨包工具名冲突（已被 ' +
                                String(toolOwners.get(tool.name)) +
                                ' 占用）：' +
                                tool.name,
                        })),
                    });
                    continue;
                }
                for (const tool of result.tools) toolOwners.set(tool.name, dirName);
                const snapshot = buildSnapshot(
                    dir,
                    root.scope,
                    result.manifest,
                    result.tools,
                    resources,
                );
                byId.set(result.manifest.id, snapshot);
                snapshots.push(snapshot);
            }
        }
        return new CapabilityRegistry(
            opts.roots,
            taxonomy,
            loadModule,
            snapshots,
            loadErrors,
            shadowedSkills,
        );
    }

    list(): readonly SkillSnapshot[] {
        return this.snapshots;
    }

    get(id: SkillId): SkillSnapshot | undefined {
        return this.snapshots.find((snapshot) => snapshot.manifest.id === id);
    }

    has(id: SkillId): boolean {
        return this.get(id) !== undefined;
    }

    errors(): readonly SkillLoadError[] {
        return this.loadErrors;
    }

    /** 被高优先级同 id 包覆盖的来源（UI 可提示「项目级覆盖了用户级」）。 */
    shadowed(): readonly ShadowedSkill[] {
        return this.shadowedSkills;
    }

    /** 全部命中候选，按置信度降序（并列按 id 字典序，保证确定性）。 */
    candidatesByIntent(query: SkillIntentQuery): readonly SkillIntentMatch[] {
        return this.snapshots
            .map((snapshot) => scoreSkillIntent(snapshot.manifest, query))
            .filter((match): match is SkillIntentMatch => match !== undefined)
            .sort(
                (left, right) =>
                    right.confidence - left.confidence || left.skillId.localeCompare(right.skillId),
            );
    }

    /** 唯一最高置信度才返回；无命中或并列 → undefined（并列由会话层询问用户，§7.3）。 */
    resolveByIntent(query: SkillIntentQuery): SkillIntentMatch | undefined {
        const candidates = this.candidatesByIntent(query);
        const top = candidates[0];
        if (top === undefined) return undefined;
        const runnerUp = candidates[1];
        if (runnerUp !== undefined && runnerUp.confidence === top.confidence) return undefined;
        return top;
    }
}
