/**
 * 能力包测试夹具：在临时根目录下生成一个自洽的 skill 包（manifest/tools/handlers/
 * memory/templates/validators/events），便于按需注入单点缺陷（CP-1 机械校验用例）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function defaultManifest(id: string): Record<string, unknown> {
    return {
        id,
        version: '0.1.0',
        name: '测试能力包',
        description: '夹具能力包',
        intents: { domains: ['personal'], categories: ['habit'], keywords: ['测试能力包'] },
        permissionCeiling: 'draft',
        tools: ['demo.append'],
        memory: { collections: [{ name: 'entries', sensitivity: 'sensitive' }] },
        templates: ['demo-prompt'],
        validators: ['entry'],
        events: {
            emits: ['skill.' + id + '.created'],
            subscribes: ['skill.' + id + '.tick'],
        },
    };
}

export function defaultTool(): Record<string, unknown> {
    return {
        name: 'demo.append',
        description: '夹具工具：写入 entries',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        minPermission: 'draft',
        sideEffects: ['db'],
        handler: { module: './handlers/capture.ts', export: 'capture' },
        validators: ['entry'],
    };
}

export const DEFAULT_HANDLER = `export async function capture(args, ctx) {
    const value = typeof args.value === 'string' ? args.value : '';
    if (ctx.memory) await ctx.memory.append('entries', { value });
    return { ok: true, tool: ctx.tool, value };
}
`;

export const DEFAULT_VALIDATOR = `export default function entryValidator(input) {
    if (typeof input.args.value !== 'string' || input.args.value.trim().length === 0) {
        return { ok: false, reason: 'value 不能为空' };
    }
    return { ok: true };
}
`;

export const DEFAULT_EVENTS = `export function handleSkillEvent(event) {
    return { handled: event.type.endsWith('.tick') };
}
`;

export interface SkillPackageInput {
    id: string;
    manifest?: Record<string, unknown>;
    /** 文件名（不含 .json）→ 工具声明。 */
    tools?: Record<string, unknown>;
    /** 模板名 → 内容。 */
    templates?: Record<string, string>;
    /** 校验器名 → TS 源码。 */
    validators?: Record<string, string>;
    /** 集合名 → schema（null 表示不写 memory/schemas.json）。 */
    memory?: Record<string, unknown> | null;
    /** handler 相对模块 → TS 源码。 */
    handlers?: Record<string, string>;
    events?: string | null;
}

/** 写入一个 skill 包并返回其目录；缺省值可直接用于「只改一个字段」的缺陷用例。 */
export function writeSkillPackage(root: string, input: SkillPackageInput): string {
    const dir = join(root, input.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify(input.manifest ?? defaultManifest(input.id), null, 2),
    );
    const tools = input.tools ?? { 'demo.append': defaultTool() };
    mkdirSync(join(dir, 'tools'), { recursive: true });
    for (const [name, declaration] of Object.entries(tools)) {
        writeFileSync(join(dir, 'tools', name + '.json'), JSON.stringify(declaration, null, 2));
    }
    const handlers = input.handlers ?? { './handlers/capture.ts': DEFAULT_HANDLER };
    for (const [module, source] of Object.entries(handlers)) {
        const path = join(dir, module);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, source);
    }
    const templates = input.templates ?? { 'demo-prompt': '# 夹具提示 {{value}}' };
    if (Object.keys(templates).length > 0) {
        mkdirSync(join(dir, 'templates'), { recursive: true });
        for (const [name, content] of Object.entries(templates)) {
            writeFileSync(join(dir, 'templates', name + '.md'), content);
        }
    }
    const validators = input.validators ?? { entry: DEFAULT_VALIDATOR };
    if (Object.keys(validators).length > 0) {
        mkdirSync(join(dir, 'validators'), { recursive: true });
        for (const [name, source] of Object.entries(validators)) {
            writeFileSync(join(dir, 'validators', name + '.ts'), source);
        }
    }
    const memory = input.memory === undefined ? { entries: { type: 'object' } } : input.memory;
    if (memory !== null && memory !== undefined) {
        mkdirSync(join(dir, 'memory'), { recursive: true });
        writeFileSync(join(dir, 'memory', 'schemas.json'), JSON.stringify(memory, null, 2));
    }
    const events = input.events === undefined ? DEFAULT_EVENTS : input.events;
    if (events !== null) writeFileSync(join(dir, 'events.ts'), events);
    return dir;
}
