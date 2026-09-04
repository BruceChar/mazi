import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ProviderConfig } from '@mazi/harness-runtime';

/** 预设：脚本演示 + pi-ai 真实厂商（含默认 key 环境变量） */
export interface ProviderPreset {
    id: string;
    label: string;
    kind: 'scripted-demo' | 'pi-ai';
    defaultKeyEnv?: string;
    models: { id: string; contextWindow: number; supportsThinking?: boolean }[];
    defaultModel: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
    {
        id: 'openai',
        label: 'OpenAI',
        kind: 'pi-ai',
        defaultKeyEnv: 'OPENAI_API_KEY',
        models: [
            { id: 'gpt-4o-mini', contextWindow: 128000 },
            { id: 'gpt-4o', contextWindow: 128000 },
        ],
        defaultModel: 'gpt-4o-mini',
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        kind: 'pi-ai',
        defaultKeyEnv: 'DEEPSEEK_API_KEY',
        models: [
            { id: 'deepseek-chat', contextWindow: 64000 },
            { id: 'deepseek-reasoner', contextWindow: 64000, supportsThinking: true },
        ],
        defaultModel: 'deepseek-chat',
    },
    {
        id: 'scripted-demo',
        label: '脚本演示（无需 key，读取 README.md）',
        kind: 'scripted-demo',
        models: [{ id: 'scripted-1', contextWindow: 64000 }],
        defaultModel: 'scripted-1',
    },
];

export function envStatus(envName: string): 'set' | 'unset' {
    const value = process.env[envName];
    return value && value.length > 0 ? 'set' : 'unset';
}

export interface ProviderSelection {
    presetId: string;
    model: string;
    /** 覆盖默认 key 环境变量；undefined = 用 preset.defaultKeyEnv */
    keyEnv?: string;
}

/** 交互输入解析：数字/逗号/空格 → 预设 id 列表 */
export function resolvePresetSelections(raw: string, allowed: ProviderPreset[]): string[] {
    const tokens = raw
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
    const ids: string[] = [];
    for (const token of tokens) {
        const idx = Number.parseInt(token, 10);
        const preset = Number.isNaN(idx) ? undefined : allowed[idx - 1];
        if (preset) {
            if (!ids.includes(preset.id)) ids.push(preset.id);
        } else if (allowed.some((p) => p.id === token)) {
            if (!ids.includes(token)) ids.push(token);
        }
    }
    return ids;
}

/** 依据选择构建 providers.json 条目 */
export function buildProviderConfig(selection: ProviderSelection): ProviderConfig {
    const preset = PROVIDER_PRESETS.find((p) => p.id === selection.presetId);
    if (!preset) {
        throw new Error(`未知 provider 预设：${selection.presetId}`);
    }
    if (preset.kind === 'scripted-demo') {
        return {
            id: 'scripted-a',
            vendor: 'scripted',
            tags: ['tools'],
            models: [
                {
                    id: 'scripted-1',
                    contextWindow: 64000,
                    supportsTools: true,
                    supportsThinking: true,
                    supportsVision: false,
                },
            ],
            driver: {
                type: 'scripted',
                rounds: [
                    {
                        reasoning: '计划：读取 README.md',
                        toolCalls: [
                            { callId: 'c1', toolName: 'fs.read', arguments: { path: 'README.md' } },
                        ],
                        usage: { inputTokens: 120, outputTokens: 12, reportedByVendor: true },
                    },
                    {
                        text: '已读取 README.md 并完成任务。',
                        usage: { inputTokens: 60, outputTokens: 30, reportedByVendor: true },
                    },
                ],
            },
            pricing: {
                currency: 'USD',
                base: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
                tiers: [],
                effectiveAt: 0,
                version: '0.0.0-scripted',
            },
            health: { score: 1 },
        };
    }
    const modelDef = preset.models.find((m) => m.id === selection.model) ?? {
        id: selection.model,
        contextWindow: 128000,
    };
    const keyEnv = selection.keyEnv ?? preset.defaultKeyEnv;
    return {
        id: preset.id,
        vendor: preset.id,
        tags: ['tools'],
        models: [
            {
                id: modelDef.id,
                contextWindow: modelDef.contextWindow,
                supportsTools: true,
                supportsThinking: modelDef.supportsThinking === true,
                supportsVision: preset.id === 'openai',
            },
        ],
        driver: {
            type: 'pi-ai',
            provider: preset.id,
            model: modelDef.id,
            // 不写 apiKeyEnv：由 driver 默认映射读取 OPENAI_API_KEY / DEEPSEEK_API_KEY
            ...(keyEnv && keyEnv !== preset.defaultKeyEnv ? { apiKeyEnv: keyEnv } : {}),
        },
        pricing: {
            currency: 'USD',
            base:
                preset.id === 'openai'
                    ? { inputPerMTok: 0.15, outputPerMTok: 0.6 }
                    : preset.id === 'deepseek'
                      ? { inputPerMTok: 0.27, outputPerMTok: 1.1 }
                      : { inputPerMTok: 1, outputPerMTok: 3 },
            tiers: [],
            effectiveAt: 0,
            version: '0.1.0',
        },
        health: { score: 1 },
    };
}

const TOOLS_JSON = `{
  "tools": [
    {
      "name": "fs.read",
      "description": "读取文件内容（只读）",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string" } },
        "required": ["path"]
      },
      "minPermission": "read-only",
      "irreversible": false,
      "sideEffects": ["fs"]
    }
  ]
}
`;

const FLAGS_JSON = '{\n  "flags": []\n}\n';

export interface GeneratedConfig {
    providers: ProviderConfig[];
    files: { name: string; content: string }[];
}

/** 纯构建：根据选择生成三个配置文件内容 */
export function buildConfigFiles(
    configDir: string,
    selections: ProviderSelection[],
): GeneratedConfig {
    const providers = selections.map((s) => buildProviderConfig(s));
    return {
        providers,
        files: [
            { name: 'providers.json', content: `${JSON.stringify({ providers }, null, 2)}\n` },
            { name: 'tools.json', content: TOOLS_JSON },
            { name: 'flags.json', content: FLAGS_JSON },
        ],
        configDir,
    } as GeneratedConfig & { configDir: string };
}

function writeGenerated(gen: GeneratedConfig, configDir: string): void {
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
    }
    for (const file of gen.files) {
        writeFileSync(join(configDir, file.name), file.content, 'utf8');
    }
}

type Questioner = (question: string, fallback?: string) => Promise<string>;

/**
 * 行队列式提问器：既支持真实终端逐条输入，也支持管道一次性喂入多行
 * （EOF 后未消费的行按缺省处理，避免管线输入导致进程悬挂）。
 */
function makeQuestioner(rl: ReturnType<typeof createInterface>): Questioner {
    const pending: string[] = [];
    const waiters: ((line: string) => void)[] = [];
    let closed = false;
    rl.on('line', (line) => {
        const waiter = waiters.shift();
        if (waiter) {
            waiter(line);
        } else {
            pending.push(line);
        }
    });
    rl.on('close', () => {
        closed = true;
        for (const waiter of waiters.splice(0)) {
            waiter('');
        }
    });
    return (question: string, fallback = '') =>
        new Promise<string>((resolve) => {
            process.stdout.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
            const next = () => {
                const line = pending.shift();
                if (line !== undefined) {
                    const trimmed = line.trim();
                    resolve(trimmed.length > 0 ? trimmed : fallback);
                } else if (closed) {
                    resolve(fallback);
                } else {
                    waiters.push((got) => {
                        const trimmed = got.trim();
                        resolve(trimmed.length > 0 ? trimmed : fallback);
                    });
                }
            };
            next();
        });
}

/** 交互式配置向导：pnpm mazi config --config-dir <dir> */
export async function runConfigure(configDir: string): Promise<GeneratedConfig> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = makeQuestioner(rl);
    try {
        return await runConfigureInner(configDir, ask);
    } finally {
        rl.close();
    }
}

async function runConfigureInner(configDir: string, ask: Questioner): Promise<GeneratedConfig> {
    process.stdout.write('=== mazi provider 交互式配置 ===\n\n');
    const real = PROVIDER_PRESETS.filter((p) => p.kind === 'pi-ai');
    process.stdout.write('可选 provider：\n');
    PROVIDER_PRESETS.forEach((p, i) => {
        const env =
            p.defaultKeyEnv && p.kind === 'pi-ai'
                ? `  env=${p.defaultKeyEnv}(${envStatus(p.defaultKeyEnv) === 'set' ? '已设置' : '未设置'})`
                : '  无需 key';
        process.stdout.write(`  ${i + 1}) ${p.label}${env}\n`);
    });
    process.stdout.write('\n');
    const rawChoice = await ask(
        '选择要启用的 provider（序号/逗号分隔，回车默认启用全部真实厂商）',
        real.map((p) => String(PROVIDER_PRESETS.indexOf(p) + 1)).join(','),
    );
    const chosen = resolvePresetSelections(rawChoice, PROVIDER_PRESETS);
    if (chosen.length === 0) {
        throw new Error('未选择任何 provider');
    }
    const selections: ProviderSelection[] = [];
    for (const presetId of chosen) {
        const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
        if (!preset) continue;
        if (preset.kind === 'scripted-demo') {
            selections.push({ presetId, model: preset.defaultModel });
            continue;
        }
        const modelRaw = await ask(
            `[${preset.label}] 模型（可选：${preset.models.map((m) => m.id).join(' / ')}）`,
            preset.defaultModel,
        );
        const model = preset.models.some((m) => m.id === modelRaw) ? modelRaw : modelRaw;
        const defaultEnv = preset.defaultKeyEnv as string;
        const status = envStatus(defaultEnv);
        const keyRaw = await ask(
            `[${preset.label}] API key 环境变量（默认 ${defaultEnv}，当前${status === 'set' ? '已设置' : '未设置'}；回车默认）`,
            defaultEnv,
        );
        selections.push({
            presetId,
            model,
            keyEnv: keyRaw || undefined,
        });
    }
    const gen = buildConfigFiles(configDir, selections);
    writeGenerated(gen, configDir);
    process.stdout.write('\n已生成配置：\n');
    for (const f of gen.files) {
        process.stdout.write(`  ${join(configDir, f.name)}\n`);
    }
    process.stdout.write('\n启动示例：\n');
    process.stdout.write(`  pnpm mazi run "<任务描述>" --config-dir ${configDir}\n`);
    return gen;
}

/** 示例（文档用）：展示一个已存在的配置文件内容片段 */
export function readGeneratedExample(): string {
    try {
        return readFileSync(join(process.cwd(), 'apps/cli/config/providers.json'), 'utf8').slice(
            0,
            400,
        );
    } catch {
        return '';
    }
}
