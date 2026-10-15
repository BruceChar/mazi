/**
 * capabilities/manifest.ts —— manifest / 工具声明的机械校验（docs/能力包规范.md §5-§6）。
 *
 * 「机械」= 只做可判定的结构、命名、引用与天花板检查，不做语义解读；任一 issue 即拒绝
 * 加载该能力包（fail-fast），由注册表汇总报错（CP-1）。
 */

import {
    type PermissionLevel,
    SKILL_SENSITIVITIES,
    type SkillEvents,
    type SkillIntents,
    type SkillManifest,
    type SkillMemoryCollection,
    type SkillToolDeclaration,
    type SkillValidationIssue,
    type SkillValidationIssueCode,
} from '@mazi/core';
import type { QuestionTaxonomy } from '@mazi/libs';
import { isKnownPermissionLevel, permissionLevelRank } from './permission.js';

const SKILL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type AddIssue = (code: SkillValidationIssueCode, path: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** 扫描阶段读到的 skill 目录资源（未验证，校验在此统一进行）。 */
export interface SkillResourceIndex {
    /** tools/*.json 的原始解析结果（文件名 + 值）。 */
    toolDeclarations: readonly { file: string; value: unknown }[];
    /** templates/<name>.md → 内容。 */
    templateContents: ReadonlyMap<string, string>;
    /** validators/<name>.<ext> → 相对模块 specifier。 */
    validators: ReadonlyMap<string, string>;
    /** memory/schemas.json 提供的集合名。 */
    memoryCollections: readonly string[];
    /** events.ts 的相对 specifier（存在时）。 */
    eventsModule?: string;
}

export interface ManifestValidationInput {
    raw: unknown;
    /** skill 目录名（必须与 manifest.id 一致）。 */
    dirName: string;
    taxonomy: QuestionTaxonomy;
    resources: SkillResourceIndex;
}

export interface ManifestValidationResult {
    ok: boolean;
    manifest?: SkillManifest;
    tools: SkillToolDeclaration[];
    issues: SkillValidationIssue[];
}

function checkRequiredString(
    raw: Record<string, unknown>,
    field: string,
    add: AddIssue,
): string | undefined {
    const value = raw[field];
    if (!isNonEmptyString(value)) {
        add('required.missing', 'manifest.' + field, '缺少必填字符串字段：' + field);
        return undefined;
    }
    return value;
}

function checkId(raw: Record<string, unknown>, dirName: string, add: AddIssue): string | undefined {
    const value = raw.id;
    if (!isNonEmptyString(value)) {
        add('required.missing', 'manifest.id', '缺少必填字段：id');
        return undefined;
    }
    if (!SKILL_ID_PATTERN.test(value)) {
        add('id.invalid', 'manifest.id', 'id 必须是 kebab-case：' + value);
        return undefined;
    }
    if (value !== dirName) {
        add('id.mismatch', 'manifest.id', 'id 必须与目录名一致：' + value + ' != ' + dirName);
        return undefined;
    }
    return value;
}

function checkVersion(raw: Record<string, unknown>, add: AddIssue): string | undefined {
    const value = raw.version;
    if (!isNonEmptyString(value)) {
        add('required.missing', 'manifest.version', '缺少必填字段：version');
        return undefined;
    }
    if (!SEMVER_PATTERN.test(value)) {
        add('version.invalid', 'manifest.version', 'version 必须是 semver：' + value);
        return undefined;
    }
    return value;
}

function checkCeiling(raw: Record<string, unknown>, add: AddIssue): PermissionLevel | undefined {
    const value = raw.permissionCeiling;
    if (!isKnownPermissionLevel(value)) {
        add(
            'permission.ceiling-invalid',
            'manifest.permissionCeiling',
            'permissionCeiling 不是合法 PermissionLevel：' + String(value),
        );
        return undefined;
    }
    return value;
}

function checkIntents(
    raw: Record<string, unknown>,
    taxonomy: QuestionTaxonomy,
    add: AddIssue,
): SkillIntents | undefined {
    const intents = raw.intents;
    if (!isRecord(intents)) {
        add('required.missing', 'manifest.intents', '缺少必填字段：intents');
        return undefined;
    }
    let ok = true;
    const domains = intents.domains;
    if (!isStringArray(domains)) {
        add('required.missing', 'manifest.intents.domains', 'intents.domains 必须是字符串数组');
        ok = false;
    } else {
        domains.forEach((domain, index) => {
            if (Object.hasOwn(taxonomy.domains, domain)) return;
            add('intent.unknown', 'manifest.intents.domains[' + index + ']', '未知主域：' + domain);
            ok = false;
        });
    }
    const knownCategories = new Set(Object.values(taxonomy.domains).flat());
    const categories = intents.categories;
    if (!isStringArray(categories)) {
        add(
            'required.missing',
            'manifest.intents.categories',
            'intents.categories 必须是字符串数组',
        );
        ok = false;
    } else {
        categories.forEach((category, index) => {
            if (knownCategories.has(category)) return;
            add(
                'intent.unknown',
                'manifest.intents.categories[' + index + ']',
                '未知子类：' + category,
            );
            ok = false;
        });
    }
    const keywords = intents.keywords;
    if (!isStringArray(keywords)) {
        add('required.missing', 'manifest.intents.keywords', 'intents.keywords 必须是字符串数组');
        ok = false;
    }
    if (!ok) return undefined;
    return {
        domains: domains as string[],
        categories: categories as string[],
        keywords: keywords as string[],
    };
}

function checkMemory(
    raw: Record<string, unknown>,
    resources: SkillResourceIndex,
    add: AddIssue,
): SkillMemoryCollection[] | undefined {
    const memory = raw.memory;
    if (!isRecord(memory) || !Array.isArray(memory.collections)) {
        add('required.missing', 'manifest.memory.collections', '缺少必填字段：memory.collections');
        return undefined;
    }
    const known = new Set(resources.memoryCollections);
    const declared = new Set<string>();
    let ok = true;
    const collections: SkillMemoryCollection[] = [];
    memory.collections.forEach((entry, index) => {
        const path = 'manifest.memory.collections[' + index + ']';
        if (!isRecord(entry) || !isNonEmptyString(entry.name)) {
            add('memory.unresolvable', path, '集合声明缺少 name');
            ok = false;
            return;
        }
        if (!known.has(entry.name)) {
            add('memory.unresolvable', path, 'memory/schemas.json 缺少集合 schema：' + entry.name);
            ok = false;
            return;
        }
        if (declared.has(entry.name)) {
            add('memory.unresolvable', path, '集合重复声明：' + entry.name);
            ok = false;
            return;
        }
        declared.add(entry.name);
        const rawSensitivity = entry.sensitivity;
        if (
            rawSensitivity !== undefined &&
            !(
                typeof rawSensitivity === 'string' &&
                (SKILL_SENSITIVITIES as readonly string[]).includes(rawSensitivity)
            )
        ) {
            add(
                'memory.sensitivity-invalid',
                path + '.sensitivity',
                'sensitivity 必须是 normal | sensitive | secret',
            );
            ok = false;
            return;
        }
        collections.push({
            name: entry.name,
            ...(rawSensitivity !== undefined
                ? { sensitivity: rawSensitivity as SkillMemoryCollection['sensitivity'] }
                : {}),
        });
    });
    return ok ? collections : undefined;
}

function checkReferences(
    value: unknown,
    known: ReadonlySet<string>,
    code: SkillValidationIssueCode,
    path: string,
    add: AddIssue,
): string[] {
    if (!isStringArray(value)) {
        add('required.missing', path, path + ' 必须是字符串数组');
        return [];
    }
    for (const name of value) {
        if (!known.has(name)) {
            add(code, path, '引用不可解析：' + name);
        }
    }
    return value;
}

function checkEvents(
    raw: Record<string, unknown>,
    id: string | undefined,
    add: AddIssue,
): SkillEvents | undefined {
    const events = raw.events;
    if (!isRecord(events)) {
        add('required.missing', 'manifest.events', '缺少必填字段：events');
        return undefined;
    }
    const prefix = id === undefined ? undefined : 'skill.' + id + '.';
    const pattern =
        prefix === undefined
            ? undefined
            : new RegExp('^' + prefix.replace(/\./g, '\\.') + '[a-z0-9]+(?:[.-][a-z0-9]+)*$');
    let ok = true;
    const check = (value: unknown, field: 'emits' | 'subscribes'): string[] => {
        if (!isStringArray(value)) {
            add(
                'required.missing',
                'manifest.events.' + field,
                'events.' + field + ' 必须是字符串数组',
            );
            ok = false;
            return [];
        }
        const seen = new Set<string>();
        for (const name of value) {
            if (pattern !== undefined && !pattern.test(name)) {
                add(
                    'event.naming-invalid',
                    'manifest.events.' + field,
                    '事件名必须遵循 skill.' + String(id) + '.<name>：' + name,
                );
                ok = false;
            }
            if (seen.has(name)) {
                add('event.duplicate', 'manifest.events.' + field, '事件重复声明：' + name);
                ok = false;
            }
            seen.add(name);
        }
        return value;
    };
    const emits = check(events.emits, 'emits');
    const subscribes = check(events.subscribes, 'subscribes');
    return ok ? { emits, subscribes } : undefined;
}

interface ParsedTool {
    declaration?: SkillToolDeclaration;
    name?: string;
}

function parseToolDeclaration(
    entry: { file: string; value: unknown },
    ceiling: PermissionLevel | undefined,
    validatorNames: ReadonlySet<string>,
    add: AddIssue,
): ParsedTool {
    const path = entry.file;
    const value = entry.value;
    if (!isRecord(value)) {
        add('tool.invalid', path, '工具声明必须是 JSON 对象');
        return {};
    }
    const name = value.name;
    if (!isNonEmptyString(name)) {
        add('tool.invalid', path, '工具声明缺少 name');
        return {};
    }
    if (!isNonEmptyString(value.description)) {
        add('tool.invalid', path, '工具声明缺少 description：' + name);
        return { name };
    }
    if (!isRecord(value.parameters)) {
        add('tool.invalid', path, '工具声明缺少 parameters（JSON Schema）：' + name);
        return { name };
    }
    const minPermission = value.minPermission;
    if (!isKnownPermissionLevel(minPermission)) {
        add('tool.invalid', path, 'minPermission 不是合法 PermissionLevel：' + name);
        return { name };
    }
    if (!isStringArray(value.sideEffects)) {
        add('tool.invalid', path, 'sideEffects 必须是字符串数组：' + name);
        return { name };
    }
    const handler = value.handler;
    if (!isRecord(handler) || !isNonEmptyString(handler.module)) {
        add('tool.invalid', path, '工具声明缺少 handler.module：' + name);
        return { name };
    }
    if (handler.export !== undefined && !isNonEmptyString(handler.export)) {
        add('tool.invalid', path, 'handler.export 必须是非空字符串：' + name);
        return { name };
    }
    if (value.validators !== undefined) {
        if (!isStringArray(value.validators)) {
            add('tool.invalid', path, 'validators 必须是字符串数组：' + name);
            return { name };
        }
        for (const validator of value.validators) {
            if (!validatorNames.has(validator)) {
                add('validator.unresolvable', path, '工具引用了未声明的校验器：' + validator);
            }
        }
    }
    if (ceiling !== undefined) {
        const declared = permissionLevelRank(minPermission);
        const limit = permissionLevelRank(ceiling);
        if (declared !== undefined && limit !== undefined && declared > limit) {
            add(
                'tool.permission-exceeds-ceiling',
                path,
                'minPermission(' +
                    minPermission +
                    ') 超过 permissionCeiling(' +
                    ceiling +
                    ')：' +
                    name,
            );
        }
    }
    return {
        name,
        declaration: {
            name,
            description: value.description,
            parameters: value.parameters,
            minPermission,
            sideEffects: value.sideEffects,
            ...(value.irreversible === true ? { irreversible: true } : {}),
            handler: {
                module: handler.module,
                ...(handler.export !== undefined ? { export: handler.export } : {}),
            },
            ...(value.validators !== undefined ? { validators: value.validators as string[] } : {}),
        },
    };
}

function checkTools(
    raw: Record<string, unknown>,
    resources: SkillResourceIndex,
    ceiling: PermissionLevel | undefined,
    validatorNames: ReadonlySet<string>,
    add: AddIssue,
): SkillToolDeclaration[] {
    const declaredNames = new Set<string>();
    const declarations: SkillToolDeclaration[] = [];
    for (const entry of resources.toolDeclarations) {
        const parsed = parseToolDeclaration(entry, ceiling, validatorNames, add);
        if (parsed.name !== undefined) {
            if (declaredNames.has(parsed.name)) {
                add('tool.duplicate', entry.file, '工具重复声明：' + parsed.name);
            }
            declaredNames.add(parsed.name);
        }
        if (parsed.declaration !== undefined) declarations.push(parsed.declaration);
    }
    if (!isStringArray(raw.tools)) {
        add('required.missing', 'manifest.tools', 'manifest.tools 必须是字符串数组');
        return declarations;
    }
    for (const name of raw.tools) {
        if (!declaredNames.has(name)) {
            add('tool.unresolvable', 'manifest.tools', '工具声明不可解析：' + name);
        }
    }
    for (const name of declaredNames) {
        if (!(raw.tools as string[]).includes(name)) {
            add('tool.invalid', 'manifest.tools', '工具声明未在 manifest.tools 中登记：' + name);
        }
    }
    return declarations;
}

/** 机械校验 manifest + 资源引用 + 工具声明；ok=false 时注册表拒绝加载。 */
export function validateSkillManifest(input: ManifestValidationInput): ManifestValidationResult {
    const issues: SkillValidationIssue[] = [];
    const add: AddIssue = (code, path, message) => {
        issues.push({ code, path, message });
    };
    if (!isRecord(input.raw)) {
        add('manifest.not-object', 'manifest.json', 'manifest.json 必须是 JSON 对象');
        return { ok: false, tools: [], issues };
    }
    const raw = input.raw;
    const id = checkId(raw, input.dirName, add);
    const version = checkVersion(raw, add);
    const ceiling = checkCeiling(raw, add);
    const intents = checkIntents(raw, input.taxonomy, add);
    const events = checkEvents(raw, id, add);
    const memory = checkMemory(raw, input.resources, add);
    const templates = checkReferences(
        raw.templates,
        new Set(input.resources.templateContents.keys()),
        'template.unresolvable',
        'manifest.templates',
        add,
    );
    const validators = checkReferences(
        raw.validators,
        new Set(input.resources.validators.keys()),
        'validator.unresolvable',
        'manifest.validators',
        add,
    );
    const tools = checkTools(raw, input.resources, ceiling, new Set(validators), add);
    const name = checkRequiredString(raw, 'name', add);
    const description = checkRequiredString(raw, 'description', add);
    if (
        issues.length > 0 ||
        id === undefined ||
        version === undefined ||
        ceiling === undefined ||
        intents === undefined ||
        events === undefined ||
        memory === undefined ||
        name === undefined ||
        description === undefined
    ) {
        return { ok: false, tools: [], issues };
    }
    return {
        ok: true,
        tools,
        issues: [],
        manifest: {
            id,
            version,
            name,
            description,
            intents,
            permissionCeiling: ceiling,
            tools: raw.tools as string[],
            memory: { collections: memory },
            templates,
            validators,
            events,
            ...(isRecord(raw.privacy) && isNonEmptyString(raw.privacy.note)
                ? { privacy: { note: raw.privacy.note } }
                : {}),
        },
    };
}
