import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
    CostBreakdown,
    EventBus,
    Goal,
    LLMMessage,
    LLMProvider,
    LLMRequest,
    PermissionLevel,
    PricingSnapshot,
    RuntimeContextBreakdown,
    RuntimeOutputBreakdown,
    Step,
    Task,
    TokenUsage,
    ToolSchema,
} from '@mazi/core';
import { type authz, modelIdOf, offeringIdOf, ProviderError, providerIdOf, ulid } from '@mazi/core';
import type { GoalTreeSnapshot } from '@mazi/libs';
import { builtinModelsFor, DEEPSEEK_ADAPTER_ID, deepseekAdapter } from '@mazi/provider';
import type { CatalogService } from './catalog/service.js';
import type { CliCommandSpec, RuntimeConfig, ToolCallResult, ToolConfig } from './config.js';
import type { GoalToolInvoker } from './gts/goal-executor.js';
import type {
    ExecutorRoundContext,
    RoundEstimate,
    RoundPin,
    RoundRawUsage,
    RoundResult,
} from './gts/round-types.js';
import { type GoalStore, SqliteGoalStore } from './memory/goal-store.js';
import {
    ConsoleSink,
    DefaultEventBus,
    newHarnessEvent,
    usageViewOf,
} from './observability/index.js';
import {
    appliedTierName,
    computeCostBreakdown,
    type PricingSchedule,
    RoundExecutor,
    type RoundOutcome,
    type RoundStreamListener,
    tierMultiplier,
    unitPricePerMTok,
} from './provider/index.js';
import { type GoalRunResult, runGoalTree } from './strategy/goal-strategy.js';
import { configureTokenizer, estimateTokens } from './token-estimator.js';
import { BUILTIN_TOOL_PRESET } from './tool-gateway/builtin.js';
import { RuntimeToolGateway } from './tool-gateway/permission.js';
import { RuntimePolicyAuditSink } from './tool-gateway/policy-audit.js';

/** 用户反馈载荷（core 旧 UserInteractionRecord 已删；事件契约只取展示字段） */
export interface FeedbackInput {
    type: string;
    content?: string;
    rating?: number;
    timestamp: number;
}

/** Conversation 内此前轮次（共享上下文的最小形态：用户输入 + 助手最终回答） */
export interface ConversationTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface RunOptions {
    userId?: string;
    /** 本次 Goal 的权限档位（composer 选择）；缺省用配置默认。 */
    permissionCeiling?: PermissionLevel;
    /** 工作区根路径；文件工具只允许读取该目录内文件 */
    workspaceRoot?: string;
    /** providerId → LLMProvider 覆盖（离线测试注入；优先生效） */
    llmProviders?: Record<string, LLMProvider>;
    /** 同一 Conversation 内此前轮次，作为本轮前置消息（共享上下文） */
    history?: ConversationTurn[];
    /** 推理强度（off/low/medium/high...），透传 provider 的 reasoningEffort */
    reasoningLevel?: string;
    /** 指定模型 id（provider 内 model id；缺省用 provider 默认模型） */
    modelId?: string;
}

/** ConversationTurn[] → LLMMessage[]（user/assistant 文本消息）。 */
function conversationMessages(turns: ConversationTurn[] | undefined): LLMMessage[] {
    if (turns === undefined || turns.length === 0) {
        return [];
    }
    return turns.map(
        (turn): LLMMessage =>
            turn.role === 'user'
                ? { role: 'user', content: [{ type: 'text', text: turn.text }] }
                : { role: 'assistant', content: [{ type: 'text', text: turn.text }] },
    );
}

function fsReadToolImpl(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: unknown; error?: string; retryable?: boolean }> {
    const path = typeof args.path === 'string' ? args.path : undefined;
    if (!path) {
        return Promise.resolve({ ok: false, error: '缺少 path 参数' });
    }
    const absolutePath = resolve(workspaceRoot ?? process.cwd(), path);
    if (workspaceRoot && !absolutePath.startsWith(resolve(workspaceRoot))) {
        return Promise.resolve({
            ok: false,
            error: 'path 超出当前工作区权限范围',
            retryable: false,
        });
    }
    try {
        const content = readFileSync(absolutePath, 'utf8');
        return Promise.resolve({ ok: true, content });
    } catch (error) {
        return Promise.resolve({ ok: false, error: (error as Error).message, retryable: false });
    }
}

/** 装配 LLMProvider 池：override 优先；deepseek 经 pi-ai 目录适配（目录不匹配/无 key 在调用期报错，装配期跳过并告警） */
function buildLlmProviders(config: RuntimeConfig, options: RunOptions): Map<string, LLMProvider> {
    const map = new Map<string, LLMProvider>();
    const overrides = options.llmProviders ?? {};
    // override 独立于 config.providers 注册（测试/宿主注入 provider 不必出现在配置列表）
    for (const [id, provider] of Object.entries(overrides)) {
        map.set(id, provider);
    }
    for (const provider of config.providers) {
        if (map.has(provider.id)) {
            continue;
        }
        if (provider.driver.provider === DEEPSEEK_ADAPTER_ID) {
            try {
                const modelIds = provider.models?.length
                    ? provider.models.map((m) => ({ id: m.id }))
                    : [{ id: provider.driver.model }];
                map.set(
                    provider.id,
                    deepseekAdapter(
                        {
                            id: provider.id,
                            adapter: DEEPSEEK_ADAPTER_ID,
                            apiKeyEnv: provider.driver.apiKeyEnv,
                            models: modelIds,
                        },
                        { env: process.env },
                    ),
                );
            } catch (error) {
                // biome-ignore lint/suspicious/noConsole: 装配期跳过告警（面向用户运行日志）
                console.warn(
                    `[runtime] skip provider '${provider.id}': ${(error as Error).message}`,
                );
            }
        }
    }
    return map;
}

/** 探测可用包管理器（macOS brew；Linux 依序 apt-get/dnf/apk） */
async function detectPackageManager(): Promise<string | undefined> {
    if (process.platform === 'darwin') {
        return 'brew';
    }
    for (const candidate of ['apt-get', 'dnf', 'apk']) {
        try {
            await promisify(execFile)('which', [candidate], { timeout: 5_000 });
            return candidate;
        } catch {
            // try next
        }
    }
    return undefined;
}

/** 自动安装缺失命令（brew/apt/dnf/apk），返回是否成功 */
async function installCliTool(spec: CliCommandSpec): Promise<{ ok: boolean; error?: string }> {
    const manager = spec.installManager ?? (await detectPackageManager());
    if (!manager) {
        return { ok: false, error: 'no package manager found (brew/apt-get/dnf/apk)' };
    }
    const pkg = spec.installPackage ?? spec.bin;
    const args =
        manager === 'brew'
            ? ['install', '-q', pkg]
            : manager === 'apt-get'
              ? ['install', '-y', pkg]
              : manager === 'dnf'
                ? ['install', '-y', pkg]
                : ['add', pkg];
    try {
        await promisify(execFile)(manager, args, { timeout: 300_000 });
        return { ok: true };
    } catch (error) {
        const err = error as { stderr?: string; message?: string };
        return {
            ok: false,
            error: `${manager} install ${pkg} failed: ${String(err.stderr ?? err.message ?? error)
                .trim()
                .slice(0, 300)}`,
        };
    }
}

/** CLI 工具执行：workspace 内以 argv 运行（不经 shell），输出截断防爆 */

async function runCliTool(
    spec: CliCommandSpec,
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const rootAbs = resolve(workspaceRoot ?? process.cwd());
    const argv: string[] = [];
    for (const token of spec.args) {
        const required = token.match(/^\{(\w+)\}$/);
        const optional = token.match(/^\{(\w+)\?\}$/);
        if (required !== null || optional !== null) {
            const key = (required ?? optional)?.[1] ?? '';
            const value = args[key];
            if (value === undefined || value === null || value === '') {
                if (required !== null) {
                    return { ok: false, error: `缺少参数：${key}` };
                }
                continue;
            }
            if (key === 'path') {
                // 路径必须落在工作区内（防越界读写）
                const target = resolve(rootAbs, String(value));
                const inside = target === rootAbs || target.startsWith(rootAbs + sep);
                if (!inside) {
                    return { ok: false, error: `path escapes the workspace: ${String(value)}` };
                }
            }
            // 数组值展开为多个 argv（如 git status --short）
            if (Array.isArray(value)) {
                for (const item of value) {
                    const part = String(item ?? '');
                    if (part.length > 0) {
                        argv.push(part);
                    }
                }
            } else {
                argv.push(String(value));
            }
            continue;
        }
        argv.push(token);
    }
    const maxChars = spec.maxOutputChars ?? 40_000;
    try {
        const { stdout } = await promisify(execFile)(spec.bin, argv, {
            cwd: rootAbs,
            timeout: spec.timeoutMs ?? 60_000,
            maxBuffer: 8 * 1_048_576,
            encoding: 'utf8',
        });
        const text = String(stdout ?? '').trim();
        if (text.length > maxChars) {
            return { ok: true, content: `${text.slice(0, maxChars)}\n…（输出已截断）` };
        }
        return { ok: true, content: text };
    } catch (error) {
        const err = error as { code?: string; stderr?: string; message?: string };
        if (err.code === 'ENOENT') {
            // 自动安装缺失命令后重试一次
            const installed = await installCliTool(spec);
            if (!installed.ok) {
                return {
                    ok: false,
                    error: `${spec.bin} is missing and auto-install failed: ${installed.error}`,
                };
            }
            try {
                const { stdout } = await promisify(execFile)(spec.bin, argv, {
                    cwd: rootAbs,
                    timeout: spec.timeoutMs ?? 30_000,
                    maxBuffer: 1_048_576,
                    encoding: 'utf8',
                });
                const text = String(stdout ?? '').trim();
                return {
                    ok: true,
                    content:
                        text.length > maxChars
                            ? `${text.slice(0, maxChars)}\n…（output truncated）`
                            : text,
                };
            } catch (retryError) {
                const retryErr = retryError as { code?: string; stderr?: string; message?: string };
                if (retryErr.code === 'ENOENT') {
                    return {
                        ok: false,
                        error: `${spec.bin} still missing after install (${spec.installPackage ?? spec.bin})`,
                    };
                }
                const stderr = String(retryErr.stderr ?? '').trim();
                return { ok: false, error: stderr || String(retryErr.message ?? retryError) };
            }
        }
        const stderr = String(err.stderr ?? '').trim();
        return { ok: false, error: stderr.slice(0, 2000) || String(err.message ?? error) };
    }
}

/**
 * 通用脚本/命令执行：bash -lc，cwd = workspace（缺省进程 cwd）。
 * 支持 node / npm / pnpm / python / bash 及任意 *.sh/*.js/*.ts/*.py；输出截断。
 */
export async function runShellTool(
    args: Record<string, unknown>,
    workspaceRoot?: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) {
        return { ok: false, error: '缺少 command' };
    }
    const requested = Number(args.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
        ? Math.min(600_000, Math.max(1_000, requested))
        : 120_000;
    const cwd = resolve(workspaceRoot ?? process.cwd());
    const MAX = 60_000;
    try {
        const { stdout, stderr } = await promisify(execFile)('bash', ['-lc', command], {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 16 * 1_048_576,
            encoding: 'utf8',
        });
        const stderrText = String(stderr ?? '').trim();
        const merged = (
            String(stdout ?? '') + (stderrText ? `\n[stderr]\n${stderrText}` : '')
        ).trim();
        const content = merged.length > 0 ? merged : '(no output)';
        return {
            ok: true,
            content: content.length > MAX ? `${content.slice(0, MAX)}\n…（输出已截断）` : content,
        };
    } catch (error) {
        const err = error as {
            killed?: boolean;
            code?: number | string;
            signal?: string;
            stdout?: string;
            stderr?: string;
            message?: string;
        };
        const head: string[] = [];
        if (err.killed) head.push(`command timed out after ${timeoutMs}ms`);
        if (typeof err.code === 'number') head.push(`exit code ${err.code}`);
        if (err.signal) head.push(`signal ${err.signal}`);
        const detail = [String(err.stdout ?? '').trim(), String(err.stderr ?? '').trim()]
            .filter(Boolean)
            .join('\n');
        const message = [head.join(', '), detail].filter(Boolean).join('\n').slice(0, 2000);
        return { ok: false, error: message || String(err.message ?? error) };
    }
}

/** 单段原文截断上限（字符）；仅审计展示，避免 payload 过大 */
const SEGMENT_CONTENT_MAX = 4000;
/** diff 原文截断上限（字符） */
const DIFF_CONTENT_MAX = 8000;

function truncateText(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
}

/**
 * 上下文分段计量（runtime input 估算）：system / user history / assistant / tool-call args /
 * tool schema / new input / observation → RuntimeContextBreakdown。文本用真实 tokenizer 估算，
 * 同时保留各段原文（截断）与相对上一轮新增内容（diffContent，按消息边界取增量）。
 */
function measureContext(
    ctx: {
        messages: LLMRequest['messages'];
        systemPrompt?: string;
        tools: ToolSchema[];
    },
    prevTotal: number | undefined,
    prevMessageCount: number | undefined,
    contextWindow: number,
): RuntimeContextBreakdown {
    const textOf = (content: readonly { type: string; text?: string }[]): string =>
        content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
    const messages = ctx.messages;
    let newInputTokens = 0;
    let observationTokens = 0;
    let historyUserTokens = 0;
    let historyAssistantTokens = 0;
    let toolCallTokens = 0;
    const parts = {
        systemPrompt: '',
        historyUser: '',
        historyAssistant: '',
        toolCalls: '',
        toolSchema: '',
        newInput: '',
        observation: '',
        retrieved: '',
        examples: '',
    };
    const diffParts: string[] = [];
    const diffByKey = {
        systemPrompt: '',
        historyUser: '',
        historyAssistant: '',
        toolCalls: '',
        toolSchema: '',
        newInput: '',
        observation: '',
        retrieved: '',
        examples: '',
    };
    // 本 Task 首轮（含续聊 Session 的首轮）：prevTotal 为 undefined；
    // 此时 system prompt / tool schema 视为全量新增。
    const isFirst = prevTotal === undefined;
    for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        if (message === undefined) continue;
        const added = prevMessageCount === undefined || i >= prevMessageCount;
        if (message.role === 'user') {
            const text = textOf(message.content);
            if (i === messages.length - 1) {
                newInputTokens = estimateTokens(text);
                parts.newInput += text;
                diffByKey.newInput += text;
                diffParts.push(text);
            } else {
                historyUserTokens += estimateTokens(text);
                parts.historyUser += `${text}\n\n`;
                if (added) {
                    diffByKey.historyUser += `${text}\n\n`;
                    diffParts.push(`[user]\n${text}`);
                }
            }
        } else if (message.role === 'tool') {
            for (const result of message.results) {
                const text =
                    typeof result.output === 'string'
                        ? result.output
                        : JSON.stringify(result.output);
                observationTokens += estimateTokens(text);
                parts.observation += `${text}\n\n`;
                if (added) {
                    diffByKey.observation += `${text}\n\n`;
                    diffParts.push(`[tool result]\n${text}`);
                }
            }
        } else if (message.role === 'assistant') {
            const text = textOf(message.content);
            historyAssistantTokens += estimateTokens(text);
            parts.historyAssistant += `${text}\n\n`;
            if (added) {
                diffByKey.historyAssistant += `${text}\n\n`;
                diffParts.push(`[assistant]\n${text}`);
            }
            for (const call of message.toolCalls ?? []) {
                const json = JSON.stringify(call);
                toolCallTokens += estimateTokens(json);
                parts.toolCalls += `${json}\n`;
                if (added) {
                    diffByKey.toolCalls += `${json}\n`;
                    diffParts.push(`[tool call]\n${json}`);
                }
            }
        }
    }
    parts.systemPrompt = ctx.systemPrompt ?? '';
    parts.toolSchema = JSON.stringify(ctx.tools ?? []);
    // 首轮：system prompt / tool schema 视为「全量新增」，之后默认不变
    if (isFirst) {
        diffByKey.systemPrompt = parts.systemPrompt;
        diffByKey.toolSchema = parts.toolSchema;
    }
    const systemPromptTokens = estimateTokens(parts.systemPrompt);
    const toolSchemaTokens = estimateTokens(parts.toolSchema);
    const historyTokens = historyUserTokens + historyAssistantTokens + toolCallTokens;
    const totalContextTokens =
        systemPromptTokens + historyTokens + toolSchemaTokens + newInputTokens + observationTokens;
    const contextWindowUtilization =
        contextWindow > 0 ? Math.min(1, totalContextTokens / contextWindow) : 0;
    // 实际装配字节数（UTF-8）：与 token 估算口径独立，落库为原始事实。
    const contextBytes =
        Buffer.byteLength(parts.systemPrompt, 'utf8') +
        Buffer.byteLength(parts.toolSchema, 'utf8') +
        Buffer.byteLength(parts.historyUser, 'utf8') +
        Buffer.byteLength(parts.historyAssistant, 'utf8') +
        Buffer.byteLength(parts.toolCalls, 'utf8') +
        Buffer.byteLength(parts.newInput, 'utf8') +
        Buffer.byteLength(parts.observation, 'utf8');
    return {
        systemPromptTokens,
        systemPromptRatio: totalContextTokens > 0 ? systemPromptTokens / totalContextTokens : 0,
        historyTokens,
        historyUserTokens,
        historyAssistantTokens,
        toolCallTokens,
        toolSchemaTokens,
        newInputTokens,
        observationTokens,
        retrievedTokens: 0,
        exampleTokens: 0,
        totalContextTokens,
        contextBytes,
        contextWindowTokens: contextWindow,
        contextWindowUtilization,
        contextDeltaFromPrev: prevTotal === undefined ? 0 : totalContextTokens - prevTotal,
        strategyApplied: [],
        contents: {
            systemPrompt: truncateText(parts.systemPrompt, SEGMENT_CONTENT_MAX),
            historyUser: truncateText(parts.historyUser, SEGMENT_CONTENT_MAX),
            historyAssistant: truncateText(parts.historyAssistant, SEGMENT_CONTENT_MAX),
            toolCalls: truncateText(parts.toolCalls, SEGMENT_CONTENT_MAX),
            toolSchema: truncateText(parts.toolSchema, SEGMENT_CONTENT_MAX),
            newInput: truncateText(parts.newInput, SEGMENT_CONTENT_MAX),
            observation: truncateText(parts.observation, SEGMENT_CONTENT_MAX),
            retrieved: '',
            examples: '',
        },
        diffContent: truncateText(diffParts.join('\n\n'), DIFF_CONTENT_MAX),
        diffContents: {
            systemPrompt: truncateText(diffByKey.systemPrompt, SEGMENT_CONTENT_MAX),
            historyUser: truncateText(diffByKey.historyUser, SEGMENT_CONTENT_MAX),
            historyAssistant: truncateText(diffByKey.historyAssistant, SEGMENT_CONTENT_MAX),
            toolCalls: truncateText(diffByKey.toolCalls, SEGMENT_CONTENT_MAX),
            toolSchema: truncateText(diffByKey.toolSchema, SEGMENT_CONTENT_MAX),
            newInput: truncateText(diffByKey.newInput, SEGMENT_CONTENT_MAX),
            observation: truncateText(diffByKey.observation, SEGMENT_CONTENT_MAX),
            retrieved: '',
            examples: '',
        },
    };
}

/** provider-runtime RoundOutcome → RoundResult（Step 回注所需最小事实面） */
function toRoundResult(outcome: RoundOutcome): {
    text: string;
    reasoning: string;
    toolCalls: Array<{ callId: string; toolName: string; arguments: Record<string, unknown> }>;
    vendorUsage?: import('@mazi/core').VendorUsage;
    raw?: RoundRawUsage;
    finishReason?: string;
    ttftMs: number;
    totalMs: number;
} {
    let text = '';
    let reasoning = '';
    for (const block of outcome.response.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'reasoning') reasoning += block.text;
    }
    const toolCalls = (outcome.response.toolCalls ?? []).map((toolCall) => ({
        callId: toolCall.callId,
        toolName: toolCall.name,
        arguments: toolCall.arguments,
    }));
    const usage = outcome.response.usage;
    const vendorUsage =
        usage === undefined
            ? undefined
            : {
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheReadInputTokens: usage.cachedInputTokens,
                  cacheCreationInputTokens: usage.cachedWriteInputTokens,
                  reasoningOutputTokens: usage.reasoningTokens,
                  reportedByVendor: true,
              };
    // 原始轮次事实：provider/model + 原始 token 计数 + 耗时（入库优先，展示/计价可重算）
    const raw: RoundRawUsage | undefined =
        usage === undefined
            ? undefined
            : {
                  providerId: outcome.metrics.providerId,
                  modelId: outcome.metrics.modelId,
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  ...(usage.cachedInputTokens !== undefined
                      ? { cachedInputTokens: usage.cachedInputTokens }
                      : {}),
                  ...(usage.cachedWriteInputTokens !== undefined
                      ? { cachedWriteInputTokens: usage.cachedWriteInputTokens }
                      : {}),
                  ...(usage.reasoningTokens !== undefined
                      ? { reasoningTokens: usage.reasoningTokens }
                      : {}),
                  totalTokens: usage.totalTokens,
                  ttftMs: outcome.metrics.ttftMs ?? 0,
                  totalMs: outcome.metrics.totalMs,
              };
    return {
        text,
        reasoning,
        toolCalls,
        ...(vendorUsage ? { vendorUsage } : {}),
        ...(raw ? { raw } : {}),
        finishReason: outcome.response.finishReason,
        ttftMs: outcome.metrics.ttftMs ?? 0,
        totalMs: outcome.metrics.totalMs,
    };
}

/** Step payload → 完整文本（大上限 60k；长内容由 UI 滚动窗口承载） */
function stepText(step: Step): string {
    const payload = step.payload;
    let text: string;
    if (step.kind === 'thinking') {
        text = String((payload as { content?: string }).content ?? '');
    } else if (step.kind === 'tool_call') {
        const call = payload as {
            toolName?: string;
            arguments?: unknown;
            callId?: string;
            output?: string;
            isError?: boolean;
        };
        text = `${call.toolName ?? ''} ${JSON.stringify(call.arguments ?? {})}`;
        // Include the settled result so live consumers see tool output/failures
        // immediately instead of only after the run-time snapshot refresh.
        if (call.output) {
            text += `\n${call.isError ? '[error] ' : '→ '}${call.output}`;
        }
    } else {
        const obs = payload as { toolName?: string; content?: string; isError?: boolean };
        text = `${obs.toolName ? `[${obs.toolName}] ` : ''}${obs.content ?? ''}${
            obs.isError ? '\n[error]' : ''
        }`;
    }
    return text.length > 60_000
        ? `${text.slice(0, 60_000)}\n…（content truncated at 60k chars）`
        : text;
}

const DEFAULT_AGENT_SYSTEM_PROMPT =
    'You are a helpful agent. Answer conversational questions directly. Only call tools when the user explicitly asks you to read, inspect, modify files, or work with the current workspace.';

/** GoalRunResult → goal.ended summary（截断 2000 字符） */
function goalRunSummary(result: GoalRunResult): string {
    const last = result.tasks[result.tasks.length - 1];
    if (result.rejected && result.rejected.length > 0) {
        return result.rejected.join('；').slice(0, 2000);
    }
    const summary = last?.finalMessage ?? last?.errorMessage;
    return summary && summary.length > 0 ? summary.slice(0, 2000) : '';
}

/** 归一化 LLM 失败事实（供事件与恢复判断消费）。 */
function describeLlmError(error: unknown): { code?: string; message: string } {
    if (error instanceof ProviderError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error) {
        return { message: error.message };
    }
    return { message: String(error) };
}

/** 判断是否为「模型名/请求不被接受」类失败（可触发重同步 + 换模重试）。 */
function isModelRelatedError(described: { code?: string; message: string }): boolean {
    if (described.code === 'invalid_request') return true;
    return /model|模型|unsupported|not found|does not exist/i.test(described.message);
}

/** 模型恢复回调入参：失败时的 provider / 模型（供按渠道定向重同步）。 */
export interface ModelRecoveryRequest {
    providerId?: string;
    modelId?: string;
}

/** 模型恢复回调返回值：修正后的 provider 与模型 id。 */
export interface ModelRecoveryResult {
    providerId?: string;
    modelId?: string;
}

/**
 * HarnessRuntime —— Goal/Task/Step 坐标系运行器（C5 收口后为唯一执行面）。
 * createGoalSession（intake+work 树落库）→ executeGoalTree（plan→逐 Task，事实经 GoalStore 留痕）；
 * 事件全部经 DefaultEventBus 落盘 JSONL（按 rootGoalId 分文件）。
 */
export class HarnessRuntime {
    private readonly bus: DefaultEventBus;
    private readonly goalStoreDb: GoalStore;
    /** 上一轮上下文总量（估算跨轮 delta 用；仅同一 Task 内有效） */
    private lastContextTotal?: number;
    /** 上一轮消息条数（取本步新增内容 diff 用；仅同一 Task 内有效） */
    private lastMessageCount?: number;
    /** 最近一次计量的 taskId（跨 Task 时重置基线） */
    private lastTaskId?: string;
    /** 待执行 Session 的 Conversation 前置消息（create → execute 之间传递） */
    private readonly pendingHistory = new Map<string, LLMMessage[]>();
    /** 待执行 Session 的推理强度（create → execute 之间传递） */
    private readonly pendingReasoning = new Map<string, string>();
    /** 待执行 Session 的模型 id（create → execute 之间传递） */
    private readonly pendingModel = new Map<string, string>();
    /** Steps already announced via step.started (a step persists several times). */
    private readonly startedStepIds = new Set<string>();
    private readonly llmProviders: Map<string, LLMProvider>;
    /** 可选目录账本：接入后每轮 usage 追加凭证（凭证闭环） */
    private catalogService: CatalogService | undefined;
    /** 可选模型恢复：模型名被厂商拒绝时重同步并换模重试一次 */
    private modelRecovery:
        | ((request: ModelRecoveryRequest) => Promise<ModelRecoveryResult | undefined>)
        | undefined;
    private readonly roundExecutor: RoundExecutor;
    private readonly config: RuntimeConfig;
    private readonly workspaceRoot?: string;
    /** Human-in-the-loop approval seam; absent → runtime gateway uses the standing ceiling approval. */
    private approvalSeam?: authz.ApprovalSeam;

    constructor(config: RuntimeConfig, options: RunOptions = {}) {
        this.config = config;
        configureTokenizer(config.tokenizerEncoding);
        this.workspaceRoot = options.workspaceRoot;
        this.bus = new DefaultEventBus({ eventDir: config.eventDir });
        this.goalStoreDb = new SqliteGoalStore(config.dbPath ?? ':memory:');
        this.llmProviders = buildLlmProviders(config, options);
        this.roundExecutor = new RoundExecutor();
        if (config.consoleEnabled ?? false) {
            this.bus.subscribe({}, new ConsoleSink());
        }
    }

    get eventBus(): EventBus {
        return this.bus;
    }

    /** 接入目录与账本：此后每轮 LLM 调用按钉死的 offering 价目追加 UsageRecord。 */
    setCatalog(service: CatalogService): void {
        this.catalogService = service;
    }

    /** 接入模型恢复：模型名被厂商拒绝时重同步并换模重试一次（llm.error 事件后自愈）。 */
    setModelRecovery(
        fn: (request: ModelRecoveryRequest) => Promise<ModelRecoveryResult | undefined>,
    ): void {
        this.modelRecovery = fn;
    }

    /** 接入人审审批 seam；缺省时运行时网关回退到 ceiling 常设授权。 */
    setApprovalSeam(seam: authz.ApprovalSeam): void {
        this.approvalSeam = seam;
    }

    /** Goal/Task/Step 存储（Goal 会话审计/级联删除） */
    get goalStore(): GoalStore {
        return this.goalStoreDb;
    }

    get currentWorkspaceRoot(): string | undefined {
        return this.workspaceRoot;
    }

    async close(): Promise<void> {
        this.goalStoreDb.close();
    }

    /** 创建 Goal 会话（intake 根 + 单 work；单意图快速路径，裁决 D4 快速路径）并持久化；发 goal.started */
    async createGoalSession(
        input: string,
        opts: RunOptions = {},
    ): Promise<{ rootGoalId: string; goalId: string }> {
        const rootGoalId = ulid();
        const history = conversationMessages(opts.history);
        if (history.length > 0) {
            this.pendingHistory.set(rootGoalId, history);
        }
        if (opts.reasoningLevel) {
            this.pendingReasoning.set(rootGoalId, opts.reasoningLevel);
        }
        if (opts.modelId) {
            this.pendingModel.set(rootGoalId, opts.modelId);
        }
        const goalId = ulid();
        const ceiling =
            opts.permissionCeiling ?? this.config.goal?.permissionCeiling ?? 'read-only';
        const intake: Goal = {
            goalId: rootGoalId,
            rootGoalId,
            origin: { kind: 'human' },
            kind: 'intake',
            statement: input,
            contract: {
                successConditions: [{ id: ulid(), checkType: 'deterministic' }],
                failureConditions: [],
                forbiddenResources: [],
                budget: {},
                terminationPolicy: {},
                riskProfile: {
                    hasIrreversibleActions: false,
                    touchesNetwork: false,
                    touchesExternalApi: false,
                },
            },
            permissionCeiling: ceiling,
            budget: {},
            status: 'active',
            createdAt: Date.now(),
        };
        const work: Goal = {
            goalId,
            rootGoalId,
            parent: { type: 'split', goalId: rootGoalId },
            kind: 'work',
            statement: input,
            contract: {
                successConditions: [{ id: ulid(), checkType: 'deterministic' }],
                failureConditions: [],
                forbiddenResources: [],
                budget: {},
                terminationPolicy: {},
                riskProfile: {
                    hasIrreversibleActions: false,
                    touchesNetwork: false,
                    touchesExternalApi: false,
                },
            },
            permissionCeiling: ceiling,
            budget: {},
            status: 'active',
            createdAt: Date.now(),
        };
        await this.goalStoreDb.saveGoal(intake);
        await this.goalStoreDb.saveGoal(work);
        this.bus.emit(
            newHarnessEvent({
                type: 'goal.started',
                rootGoalId,
                goalId,
                attributes: {},
                payload: {
                    rawInput: input,
                    inputTimestamp: Date.now(),
                    userId: opts.userId ?? undefined,
                },
            }),
        );
        await this.bus.flush();
        return { rootGoalId, goalId };
    }

    /** 执行 Goal 树（plan → 逐 Task；事实全部经 goalStore 留痕）；发 goal.ended */
    async executeGoalTree(rootGoalId: string): Promise<GoalRunResult> {
        const goals = await this.goalStoreDb.listGoalsByRoot(rootGoalId);
        if (goals.length === 0) {
            throw new Error(`Goal 树不存在：${rootGoalId}`);
        }
        // 每轮 run 重置上下文基线：首个 round 的 delta 从 0 起算，不与上一个会话串味。
        this.lastContextTotal = undefined;
        this.lastMessageCount = undefined;
        this.lastTaskId = undefined;
        const history = this.pendingHistory.get(rootGoalId) ?? [];
        this.pendingHistory.delete(rootGoalId);
        const reasoningLevel = this.pendingReasoning.get(rootGoalId);
        this.pendingReasoning.delete(rootGoalId);
        const modelId = this.pendingModel.get(rootGoalId);
        this.pendingModel.delete(rootGoalId);
        const model = this.resolveModelChoice(modelId);
        const workGoal = goals.find((goal) => goal.kind === 'work');
        const exec = this.goalExecutionConfig(
            rootGoalId,
            workGoal?.goalId ?? rootGoalId,
            workGoal?.permissionCeiling ?? this.config.goal?.permissionCeiling ?? 'read-only',
        );
        const result = await runGoalTree(
            {
                store: this.goalStoreDb,
                requestRound: (ctx) => this.requestRound(rootGoalId, ctx, reasoningLevel),
                systemPrompt: this.config.systemPrompt ?? DEFAULT_AGENT_SYSTEM_PROMPT,
                tools: exec.tools,
                invoker: exec.invoker,
                allowedTools: exec.allowedTools,
                ...(history.length > 0 ? { history } : {}),
                ...(model ? { model } : {}),
                ...(this.workspaceRoot !== undefined ? { workspaceRoot: this.workspaceRoot } : {}),
                onStep: (step) => this.emitStep(rootGoalId, step),
            },
            goals,
        );
        // Settle the Goal entities so the persisted tree/snapshot no longer reports
        // every goal as 'active' after the run has finished.
        const outcomeByGoal = new Map(
            result.tasks.map((outcome) => [outcome.task.goalId, outcome]),
        );
        for (const goal of goals) {
            const settled = result.ok ? 'succeeded' : 'failed';
            if (goal.kind === 'work') {
                goal.status = outcomeByGoal.get(goal.goalId)?.ok ? 'succeeded' : 'failed';
            } else if (goal.kind === 'intake') {
                goal.status = settled;
            } else {
                continue;
            }
            await this.goalStoreDb.saveGoal(goal);
        }
        this.bus.emit(
            newHarnessEvent({
                type: 'goal.ended',
                rootGoalId,
                payload: {
                    outcome: {
                        status: result.ok ? 'success' : 'failed',
                        summary: goalRunSummary(result),
                    },
                    error: result.rejected?.join('；'),
                },
            }),
        );
        await this.bus.flush();
        return result;
    }

    /** 一站式 Goal 会话：创建 + 执行 + 返回结果与树快照（apps/api 端点消费） */
    async runGoalSession(
        input: string,
        opts: RunOptions = {},
    ): Promise<{
        rootGoalId: string;
        result: GoalRunResult;
        snapshot: GoalTreeSnapshot;
    }> {
        const created = await this.createGoalSession(input, opts);
        const result = await this.executeGoalTree(created.rootGoalId);
        const snapshot = await this.goalSnapshot(created.rootGoalId);
        return { rootGoalId: created.rootGoalId, result, snapshot };
    }

    /** 重建 Goal 树四元组快照（审计/展示视图） */
    async goalSnapshot(rootGoalId: string): Promise<GoalTreeSnapshot> {
        const goals = await this.goalStoreDb.listGoalsByRoot(rootGoalId);
        const tasks: Task[] = [];
        const steps: Step[] = [];
        for (const goal of goals) {
            const goalTasks = await this.goalStoreDb.listTasks(goal.goalId);
            tasks.push(...goalTasks);
            for (const task of goalTasks) {
                steps.push(...(await this.goalStoreDb.listSteps(task.taskId)));
            }
        }
        const { snapshotGoalTree } = await import('./observability/goal-snapshot.js');
        return snapshotGoalTree(rootGoalId, goals, tasks, steps);
    }

    /** Step 落库即时事件：经事件总线实时推送（SSE/UI 流式展示） */
    private emitStep(rootGoalId: string, step: Step): void {
        const usage = usageViewOf(step.usage);
        const payload: Record<string, unknown> = {
            kind: step.kind,
            status: step.status,
            goalId: step.goalId,
            taskId: step.taskId,
            content: stepText(step),
        };
        if (usage !== undefined) {
            payload.usage = usage;
        }
        // Announce the step once when it first reaches the store, then emit an
        // ended event on every persist (tool calls: running -> ok updates).
        if (!this.startedStepIds.has(step.stepId)) {
            this.startedStepIds.add(step.stepId);
            this.bus.emit(
                newHarnessEvent({
                    type: 'step.started',
                    rootGoalId,
                    goalId: step.goalId,
                    taskId: step.taskId,
                    stepId: step.stepId,
                    payload,
                }),
            );
        }
        this.bus.emit(
            newHarnessEvent({
                type: 'step.ended',
                rootGoalId,
                goalId: step.goalId,
                taskId: step.taskId,
                stepId: step.stepId,
                payload,
            }),
        );
    }

    /** 用户对 root goal 结果的反馈（CLI/调用方显式给出） */
    recordFeedback(rootGoalId: string, feedback: FeedbackInput): Promise<void> {
        this.bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                rootGoalId,
                attributes: { 'user.feedback_type': feedback.type },
                payload: { feedback },
            }),
        );
        return this.bus.flush();
    }

    /**
     * Goal 执行的工具面：内置 CLI 预设 + config.tools → 经 v2 ToolGateway 判权的
     * ToolSchema/执行器/白名单。supply 视图只暴露当前 permissionCeiling 允许的工具；
     * 白名单缺省 = 全部可见工具；显式空数组 = 纯对话（不注入工具 schema）。
     */
    private goalExecutionConfig(
        rootGoalId: string,
        goalId: string,
        level: PermissionLevel,
    ): {
        tools: ToolSchema[];
        invoker: GoalToolInvoker;
        allowedTools: string[];
    } {
        // 预设与配置同名合并：配置覆盖预设；其余内置 CLI 工具自动可用
        const merged: ToolConfig[] = [...BUILTIN_TOOL_PRESET];
        for (const tool of this.config.tools) {
            const idx = merged.findIndex((t) => t.name === tool.name);
            if (idx >= 0) {
                merged[idx] = tool;
            } else {
                merged.push(tool);
            }
        }
        const gateway = new RuntimeToolGateway({
            rootGoalId,
            goalId,
            taskId: goalId,
            level,
            tools: merged,
            execute: (tool, args) => this.executeToolConfig(tool, args),
            ...(this.workspaceRoot !== undefined ? { workspaceRoot: this.workspaceRoot } : {}),
            audit: new RuntimePolicyAuditSink({ emit: (event) => this.bus.emit(event) }),
            ...(this.approvalSeam ? { approval: this.approvalSeam } : {}),
        });
        const visible = new Set(gateway.visibleToolNames());
        const configured = this.config.goal?.allowedTools;
        const names = (configured === undefined ? merged.map((t) => t.name) : configured).filter(
            (name) => visible.has(name),
        );
        const tools: ToolSchema[] = merged
            .filter((t) => names.includes(t.name))
            .map((t) => ({
                name: t.name,
                description: t.description,
                parameters: (t.parameters ?? undefined) as ToolSchema['parameters'],
            }));
        const invoke: GoalToolInvoker['invoke'] = async (toolName, args, ctx) => {
            const result = await gateway.invoke(toolName, args, ctx ?? {});
            return result.ok
                ? { ok: true, content: String(result.content ?? '') }
                : { ok: false, content: '', error: result.error ?? 'tool failed' };
        };
        return { tools, invoker: { invoke }, allowedTools: names };
    }

    /** 工具配置执行：fs.read / shell.run / CLI command / impl（经网关判权后调用）。 */
    private async executeToolConfig(
        tool: ToolConfig | undefined,
        args: Record<string, unknown>,
    ): Promise<ToolCallResult> {
        const toolName = tool?.name ?? '';
        if (toolName === 'fs.read') {
            const res = await fsReadToolImpl(args, this.workspaceRoot);
            return res.ok
                ? { ok: true, content: String(res.content ?? '') }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        if (toolName === 'shell.run') {
            const res = await runShellTool(args, this.workspaceRoot);
            return res.ok
                ? { ok: true, content: res.content ?? '' }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        if (tool?.command) {
            const res = await runCliTool(tool.command, args, this.workspaceRoot);
            return res.ok
                ? { ok: true, content: res.content ?? '' }
                : { ok: false, error: res.error ?? 'tool failed' };
        }
        const impl = tool?.impl;
        if (!impl) {
            return { ok: false, error: `工具未实现：${toolName}` };
        }
        const res = await impl(args);
        return res.ok
            ? { ok: true, content: String(res.content ?? '') }
            : { ok: false, error: res.error ?? 'tool failed' };
    }

    /** 由模型 id 解析所属 provider（配置内取第一个匹配）；未命中 → undefined。 */
    private resolveModelChoice(
        modelId?: string,
    ): { providerId: string; modelId: string } | undefined {
        if (!modelId) {
            return undefined;
        }
        const provider = this.config.providers.find((item) =>
            (item.models ?? []).some((model) => model.id === modelId),
        );
        return provider ? { providerId: provider.id, modelId } : undefined;
    }

    private defaultModelOf(providerId: string): string {
        const entry = this.config.providers.find((p) => p.id === providerId);
        return entry?.driver.model || entry?.models?.[0]?.id || '';
    }

    /**
     * 解析计价表：优先该模型的专属价目（官网抓取按 flash/pro 分别写入），
     * 缺省回落到 provider 级 pricing。
     */
    private pricingOf(providerId: string, modelId?: string): PricingSchedule | undefined {
        const entry = this.config.providers.find((p) => p.id === providerId);
        if (entry === undefined) return undefined;
        if (modelId !== undefined) {
            const model = entry.models?.find((item) => item.id === modelId);
            if (model?.pricing !== undefined) return model.pricing;
        }
        return entry.pricing;
    }

    /**
     * 解析生效的上下文窗口（token）：模型级 contextWindow → provider 首个模型 → 运行时兜底。
     * 上下文占比按真实模型窗口计算（如 1M），而非固定 64K。
     */
    private contextWindowOf(providerId: string, modelId?: string): number {
        const entry = this.config.providers.find((p) => p.id === providerId);
        const byModel =
            modelId !== undefined ? entry?.models?.find((item) => item.id === modelId) : undefined;
        const fallbackModel = entry?.models?.find(
            (item) => item.id === (entry?.driver.model || entry?.models?.[0]?.id),
        );
        // 目录（pi-ai）里已知模型的窗口兜底（providers.json 未标注 contextWindow 时）。
        const vendor = entry?.driver?.provider ?? '';
        const catalog = builtinModelsFor(vendor);
        const catalogWindow = (id?: string): number | undefined =>
            id !== undefined
                ? catalog.find((info) => info.id === id)?.capabilities.maxInputTokens
                : undefined;
        return (
            byModel?.contextWindow ??
            fallbackModel?.contextWindow ??
            entry?.models?.[0]?.contextWindow ??
            catalogWindow(modelId) ??
            catalogWindow(fallbackModel?.id) ??
            this.config.contextWindow ??
            64000
        );
    }

    /** 解析候选 provider 的模型 id：命中 ctx 目标且非占位值时用 ctx 模型，否则取配置/默认模型 */
    private roundModelId(
        id: string,
        ctxModel: { providerId: string; modelId: string },
        provider: LLMProvider,
    ): string | undefined {
        if (id === ctxModel.providerId && ctxModel.modelId && ctxModel.modelId !== 'default') {
            return ctxModel.modelId;
        }
        return this.defaultModelOf(id) || provider.defaultModel || undefined;
    }

    /**
     * 单次 LLM 轮次：经 provider-runtime RoundExecutor（重试/failover 在 provider-runtime 内）。
     * 具备 goalId/taskId 时，把 provider 原始流式增量包装成 llm.stream_event 实时发到事件总线
     * （docs/web/流式响应设计.md §2）；同一轮的多次网络尝试共享 streamId，attempt 区分重试。
     */
    private buildCandidates(
        ctx: ExecutorRoundContext,
        modelOverride?: string,
    ): Array<{
        providerId: string;
        provider: LLMProvider;
        modelId?: string;
        pricing?: PricingSchedule;
    }> {
        const orderedIds = [
            ctx.model.providerId,
            ...[...this.llmProviders.keys()].filter((id) => id !== ctx.model.providerId),
        ];
        return orderedIds
            .map((id) => ({ id, provider: this.llmProviders.get(id) }))
            .filter((x): x is { id: string; provider: LLMProvider } => x.provider !== undefined)
            .map(({ id, provider }) => {
                const modelId =
                    id === ctx.model.providerId && modelOverride !== undefined
                        ? modelOverride
                        : this.roundModelId(id, ctx.model, provider);
                return {
                    providerId: id,
                    provider,
                    ...(modelId !== undefined ? { modelId } : {}),
                    ...(this.pricingOf(id, modelId) !== undefined
                        ? { pricing: this.pricingOf(id, modelId) }
                        : {}),
                };
            });
    }

    /** 模型被厂商拒绝时发 llm.error，自愈（重同步 + 换模）后重试一次（provider.recovered）。 */
    private async requestRound(
        rootGoalId: string,
        ctx: ExecutorRoundContext,
        reasoningLevel?: string,
    ): Promise<RoundResult> {
        // 不设 request.model：模型 id 交由 provider-runtime 按候选（candidate.modelId）解析，
        // 避免占位 modelId（goal-executor 缺省 'default'）覆盖真实模型而报 unknown model。
        const request: LLMRequest = {
            ...(ctx.systemPrompt ? { system: ctx.systemPrompt } : {}),
            messages: ctx.messages,
            ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
            // 'off' 时不发送 reasoningEffort：pi-ai 据此下发 thinking:{type:'disabled'}；
            // 若原样发送 'off' 会被判为「开启思考」并带上非法 reasoning_effort，导致无输出。
            ...(reasoningLevel && reasoningLevel.length > 0 && reasoningLevel !== 'off'
                ? { extra: { reasoningEffort: reasoningLevel } }
                : {}),
        };
        // runtime 维度：请求发出前的上下文分段计量（同一 Task 内累计 delta / 新增内容）
        const sameTask = ctx.taskId !== undefined && ctx.taskId === this.lastTaskId;
        const contextUsage = measureContext(
            ctx,
            sameTask ? this.lastContextTotal : undefined,
            sameTask ? this.lastMessageCount : ctx.baseMessageCount,
            this.contextWindowOf(ctx.model.providerId, ctx.model.modelId),
        );
        const streamId = ulid();
        const streamable = ctx.goalId !== undefined && ctx.taskId !== undefined;
        const onStream: RoundStreamListener | undefined = streamable
            ? (streamEvent) => {
                  this.bus.emit(
                      newHarnessEvent({
                          type: 'llm.stream_event',
                          rootGoalId,
                          goalId: ctx.goalId,
                          taskId: ctx.taskId,
                          attributes: {
                              'gen_ai.provider.name': streamEvent.providerId,
                              'gen_ai.request.model': streamEvent.modelId,
                          },
                          payload: {
                              streamId,
                              attempt: streamEvent.attempt,
                              event: streamEvent.event,
                          },
                      }),
                  );
              }
            : undefined;

        let modelOverride: string | undefined;
        for (let attempt = 0; ; attempt += 1) {
            const candidates = this.buildCandidates(ctx, modelOverride);
            if (candidates.length === 0) {
                throw new Error(`没有可用 provider：${ctx.model.providerId}`);
            }
            const firstProvider = candidates[0]?.provider;
            const resolvedModel =
                modelOverride ??
                (firstProvider !== undefined
                    ? this.roundModelId(ctx.model.providerId, ctx.model, firstProvider)
                    : undefined);
            try {
                const outcome = await this.roundExecutor.execute(request, candidates, onStream);
                if (modelOverride !== undefined) {
                    await this.emitRecovered(
                        rootGoalId,
                        ctx,
                        modelOverride,
                        outcome.metrics.providerId,
                    );
                }
                return await this.finishRound(ctx, contextUsage, outcome);
            } catch (error) {
                const described = describeLlmError(error);
                this.bus.emit(
                    newHarnessEvent({
                        type: 'llm.error',
                        rootGoalId,
                        goalId: ctx.goalId,
                        taskId: ctx.taskId,
                        attributes: {
                            'gen_ai.provider.name': ctx.model.providerId,
                            'harness.level': 'error',
                            ...(described.code !== undefined
                                ? { 'harness.provider_error_code': described.code }
                                : {}),
                        },
                        payload: {
                            code: described.code,
                            message: described.message,
                            model: resolvedModel,
                            attempt,
                        },
                    }),
                );
                await this.bus.flush();
                const recovery = this.modelRecovery;
                const canRecover =
                    attempt === 0 && recovery !== undefined && isModelRelatedError(described);
                if (!canRecover) throw error;
                const recovered = await recovery({
                    providerId: ctx.model.providerId,
                    ...(resolvedModel !== undefined ? { modelId: resolvedModel } : {}),
                }).catch(() => undefined);
                if (recovered?.modelId === undefined) throw error;
                modelOverride = recovered.modelId;
            }
        }
    }

    private async emitRecovered(
        rootGoalId: string,
        ctx: ExecutorRoundContext,
        modelId: string,
        providerId: string,
    ): Promise<void> {
        this.bus.emit(
            newHarnessEvent({
                type: 'provider.recovered',
                rootGoalId,
                goalId: ctx.goalId,
                taskId: ctx.taskId,
                attributes: {
                    'gen_ai.provider.name': providerId,
                    'gen_ai.request.model': modelId,
                    'harness.level': 'info',
                },
                payload: { providerId, modelId },
            }),
        );
        await this.bus.flush();
    }

    private async finishRound(
        ctx: ExecutorRoundContext,
        contextUsage: RuntimeContextBreakdown,
        outcome: RoundOutcome,
    ): Promise<RoundResult> {
        const result: RoundResult = toRoundResult(outcome);
        this.lastContextTotal = contextUsage.totalContextTokens;
        this.lastMessageCount = ctx.messages.length;
        this.lastTaskId = ctx.taskId;
        // 输入漂移：有符号（breakdown total − vendor.input），并给出漂移率
        const vendorInput = result.vendorUsage?.inputTokens;
        if (vendorInput !== undefined) {
            const drift = contextUsage.totalContextTokens - vendorInput;
            contextUsage.estimationDriftTokens = drift;
            contextUsage.estimationDriftRate = vendorInput > 0 ? drift / vendorInput : undefined;
        }
        const estimate = this.roundEstimate(result);
        const cost = this.roundCost(outcome);
        const estimatedCost = this.roundEstimatedCost(outcome, contextUsage, estimate);
        const output = this.outputBreakdown(result);
        const pricing = this.pricingSnapshot(outcome);
        const pin = await this.recordCatalogUsage(outcome);
        return {
            ...result,
            contextUsage,
            ...(pin !== undefined ? { pin } : {}),
            ...(estimate !== undefined ? { estimate } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(pricing !== undefined ? { pricing } : {}),
            ...(cost !== undefined ? { cost } : {}),
            ...(estimatedCost !== undefined ? { estimatedCost } : {}),
        };
    }

    /** 输出分段估算：reasoning / tool-call args / text（image/video 预留）。 */
    private outputBreakdown(result: RoundResult): RuntimeOutputBreakdown | undefined {
        const reasoningTokens = estimateTokens(result.reasoning);
        const textTokens = estimateTokens(result.text);
        const toolCalls = result.toolCalls ?? [];
        const toolCallArgsTokens = toolCalls.reduce(
            (sum, call) => sum + estimateTokens(JSON.stringify(call)),
            0,
        );
        const totalOutputTokens = reasoningTokens + toolCallArgsTokens + textTokens;
        if (result.vendorUsage === undefined && totalOutputTokens === 0) {
            return undefined;
        }
        return {
            reasoningTokens,
            toolCallArgsTokens,
            textTokens,
            totalOutputTokens,
            contents: {
                reasoning: truncateText(result.reasoning, SEGMENT_CONTENT_MAX),
                toolCalls: truncateText(
                    toolCalls.map((call) => JSON.stringify(call)).join('\n'),
                    SEGMENT_CONTENT_MAX,
                ),
                text: truncateText(result.text, SEGMENT_CONTENT_MAX),
            },
        };
    }

    /** 本轮计价快照（生效倍率后的单价，$/MTok），随 usage 入库。 */
    private pricingSnapshot(outcome: RoundOutcome): PricingSnapshot | undefined {
        const pricing = this.pricingOf(outcome.metrics.providerId, outcome.metrics.modelId);
        if (pricing === undefined) {
            return undefined;
        }
        const hourUtc = new Date().getUTCHours();
        const effective = (component: 'input' | 'cache-read' | 'output' | 'reasoning'): number =>
            tierMultiplier(pricing, hourUtc, component) *
            (unitPricePerMTok(pricing, component) ?? 0);
        return {
            inputPerMTok: effective('input'),
            cachedInputPerMTok: effective('cache-read'),
            outputPerMTok: effective('output'),
            ...(pricing.base.reasoningPerMTok !== undefined
                ? { reasoningPerMTok: effective('reasoning') }
                : {}),
            currency: pricing.currency,
            version: pricing.version,
            tier: appliedTierName(pricing, hourUtc),
        };
    }

    /**
     * 凭证闭环：把本轮 usage 按派发时刻钉死的 offering 价目追加进账本。
     * 目录未收录或无价的 offering 不产生凭证（目录是权威，缺失不阻断对话）。
     */
    private async recordCatalogUsage(outcome: RoundOutcome): Promise<RoundPin | undefined> {
        const service = this.catalogService;
        const usage = outcome.metrics.usage;
        if (service === undefined || usage === undefined) return undefined;
        const offeringId = offeringIdOf(
            providerIdOf(outcome.metrics.providerId),
            modelIdOf(outcome.metrics.modelId),
        );
        try {
            const pin = service.pin(offeringId);
            await service.settle(pin, {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                cacheReadTokens: usage.cachedInputTokens ?? 0,
            });
            return {
                offeringId: pin.offeringId,
                pricingPlanId: pin.pricingPlanId,
                catalogEpoch: pin.catalogEpoch,
            };
        } catch {
            // 目录未收录或无价：跳过凭证，不影响本轮对话。
            return undefined;
        }
    }

    /** 本轮成本拆分：仅当厂商上报 usage 且候选命中计价表时产出。 */
    private roundCost(outcome: RoundOutcome): CostBreakdown | undefined {
        const usage = outcome.metrics.usage;
        const pricing = this.pricingOf(outcome.metrics.providerId, outcome.metrics.modelId);
        if (usage === undefined || pricing === undefined) {
            return undefined;
        }
        return computeCostBreakdown(usage, pricing, new Date());
    }

    /** 输出估算与漂移：estimate.output − (vendor.output − vendor.reasoning)。 */
    private roundEstimate(result: RoundResult): RoundEstimate | undefined {
        const outputTokens = estimateTokens(result.text);
        if (result.vendorUsage === undefined && outputTokens === 0) {
            return undefined;
        }
        const vendorNonReasoning = Math.max(
            0,
            (result.vendorUsage?.outputTokens ?? 0) -
                (result.vendorUsage?.reasoningOutputTokens ?? 0),
        );
        const drift = outputTokens - vendorNonReasoning;
        return {
            outputTokens,
            ...(result.vendorUsage !== undefined
                ? {
                      outputDriftTokens: drift,
                      outputDriftRate:
                          vendorNonReasoning > 0 ? drift / vendorNonReasoning : undefined,
                  }
                : {}),
        };
    }

    /** 以 runtime 估算 token 重算成本（与 vendor 成本对照）；未配计价或缺估算时缺省。 */
    private roundEstimatedCost(
        outcome: RoundOutcome,
        contextUsage: RuntimeContextBreakdown,
        estimate: RoundEstimate | undefined,
    ): CostBreakdown | undefined {
        const pricing = this.pricingOf(outcome.metrics.providerId, outcome.metrics.modelId);
        if (pricing === undefined || estimate === undefined) {
            return undefined;
        }
        const estimatedUsage: TokenUsage = {
            inputTokens: contextUsage.totalContextTokens,
            cachedInputTokens: 0,
            outputTokens: estimate.outputTokens,
            reasoningTokens: 0,
            totalTokens: contextUsage.totalContextTokens + estimate.outputTokens,
        };
        return computeCostBreakdown(estimatedUsage, pricing, new Date());
    }
}
