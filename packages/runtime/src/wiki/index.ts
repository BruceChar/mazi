import type { Step } from '@mazi/core';
import {
    buildWikiInjection,
    DEFAULT_INJECT_BUDGET_TOKENS,
    DEFAULT_RECENT_ENTRIES,
    renderWikiSection,
} from './injector.js';
import { DEFAULT_IGNORED_DIRS } from './naming.js';
import { type WikiDoc, type WikiEntry, WikiStore } from './store.js';
import { TemplateSummarizer, type WikiSummarizer } from './summarizer.js';
import { DEFAULT_SNAPSHOT_THRESHOLD, type WikiFlushContext, WikiWriter } from './writer.js';

export * from './injector.js';
export * from './naming.js';
export * from './store.js';
export * from './summarizer.js';
export * from './writer.js';

/** 会话运行时开关（对应 settings.json 的 wiki 段；设计 §12）。 */
export interface WikiRuntimeOptions {
    enabled?: boolean;
    injectBudgetTokens?: number;
    snapshotThreshold?: number;
    logLimit?: number;
    recentEntries?: number;
    summaryModel?: string;
}

export interface WikiServiceOptions extends WikiRuntimeOptions {
    home: string;
    /** 项目工作区；缺省/空串 → wiki 静默禁用（设计 §5）。 */
    workspace?: string;
    sessionId?: string;
    summarizer?: WikiSummarizer;
    now?: () => Date;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface WikiToolResult {
    ok: boolean;
    content?: string;
    error?: string;
}

/** 可能写工作区的工具（判定写语义；是否真改动由回合末兜底 diff 决定，设计 §7.1）。 */
export const WRITE_TOOLS: readonly string[] = [
    'fs.write',
    'fs.edit',
    'fs.patch',
    'fs.copy',
    'fs.move',
    'apply_patch',
    'edit',
    'write',
    'sd',
    'shell.run',
    'git',
];

const PATH_KEYS = ['path', 'paths', 'file', 'files', 'target', 'targets'];

export function isWriteTool(toolName: string): boolean {
    return WRITE_TOOLS.includes(toolName);
}

/** 从工具参数解析候选路径（解析不出时依赖兜底 diff）。 */
export function extractWritePaths(args: Record<string, unknown>): string[] {
    const found: string[] = [];
    for (const key of PATH_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && value.length > 0) found.push(value);
        else if (Array.isArray(value)) {
            for (const item of value) {
                if (typeof item === 'string' && item.length > 0) found.push(item);
            }
        }
    }
    return found;
}

export interface WikiReadToolArgs {
    section?: 'snapshot' | 'log' | 'all';
    limit?: number;
}

export interface WikiUpdateToolArgs {
    snapshot?: string;
    entries?: string | string[];
}

/**
 * WikiService —— 项目 wiki 的读写门面（runtime 注入/捕获/收尾，API 只读展示共用）。
 * 全部副作用发生在 MAZI_HOME，工作区只读（设计 §3）。
 */
export class WikiService {
    private readonly store: WikiStore | undefined;
    private readonly writer: WikiWriter | undefined;
    private readonly budgetTokens: number;
    private readonly recentEntries: number;

    constructor(options: WikiServiceOptions) {
        this.budgetTokens = options.injectBudgetTokens ?? DEFAULT_INJECT_BUDGET_TOKENS;
        this.recentEntries = options.recentEntries ?? DEFAULT_RECENT_ENTRIES;
        const workspace = options.workspace?.trim() ?? '';
        const usable = (options.enabled ?? true) !== false && workspace.length > 0;
        let store: WikiStore | undefined;
        let writer: WikiWriter | undefined;
        if (usable) {
            store = new WikiStore({
                home: options.home,
                workspace,
                ...(options.logLimit !== undefined ? { logLimit: options.logLimit } : {}),
                ...(options.now !== undefined ? { now: options.now } : {}),
            });
            writer = new WikiWriter({
                store,
                workspace: store.workspace,
                summarizer: options.summarizer ?? new TemplateSummarizer(),
                ...(options.now !== undefined ? { now: options.now } : {}),
                ...(options.snapshotThreshold !== undefined
                    ? { snapshotThreshold: options.snapshotThreshold }
                    : {}),
                ignore: DEFAULT_IGNORED_DIRS,
            });
        }
        this.store = store;
        this.writer = writer;
    }

    get enabled(): boolean {
        return this.store !== undefined;
    }

    get project(): string | undefined {
        return this.store?.project;
    }

    get filePath(): string | undefined {
        return this.store?.file;
    }

    get workspacePath(): string | undefined {
        return this.store?.workspace;
    }

    /** 当前 wiki 文档（不存在返回 undefined）。 */
    snapshot(): WikiDoc | undefined {
        return this.store?.read();
    }

    /** 新会话注入片段；禁用时返回空串（设计 §8）。 */
    promptFragment(): string {
        if (this.store === undefined) return '';
        try {
            return buildWikiInjection(this.store.read(), {
                budgetTokens: this.budgetTokens,
                recentEntries: this.recentEntries,
            });
        } catch (error) {
            this.warn('注入片段生成失败：' + describeError(error));
            return '';
        }
    }

    /** 会话/回合开始：建立兜底 diff 基线；无快照时先落地确定性项目概览（设计 §8）。 */
    async beginRun(): Promise<void> {
        if (this.writer === undefined) return;
        try {
            await this.writer.beginRun();
        } catch (error) {
            this.warn('项目概览 bootstrap 失败：' + describeError(error));
        }
    }

    /** Step 观测：写工具成功 → 记 pending（设计 §7.1）。 */
    observeStep(step: Step): void {
        if (this.writer === undefined) return;
        if (step.kind !== 'invocation') return;
        // 仅终态成功计一条 pending（active/pending 是中间态，error/skipped 不算改动）
        if (step.status !== 'succeeded') return;
        const toolName = step.payload.toolName;
        if (!isWriteTool(toolName)) return;
        try {
            this.writer.record(toolName, extractWritePaths(step.payload.arguments ?? {}));
        } catch (error) {
            this.warn('写事件捕获失败：' + describeError(error));
        }
    }

    /** 回合/会话收尾：合并 pending + 兜底 diff → 追加『时间 | 改动』条目。 */
    async flushRun(context: WikiFlushContext = {}): Promise<WikiEntry[]> {
        if (this.writer === undefined) return [];
        try {
            const result = await this.writer.flushRun(context);
            return result.entries;
        } catch (error) {
            // MAZI_HOME 不可写 / 摘要失败等：记 warn，不阻断会话（设计 §14）
            this.warn('收尾写入失败：' + describeError(error));
            return [];
        }
    }

    private warn(message: string): void {
        process.stderr.write('[wiki] ' + message + '\n');
    }

    /** wiki.read 工具（只读，免审批）。 */
    readForTool(args: WikiReadToolArgs = {}): WikiToolResult {
        if (this.store === undefined) return { ok: true, content: '（wiki 未启用）' };
        const section =
            args.section === 'log' || args.section === 'all' ? args.section : 'snapshot';
        const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
        const content = renderWikiSection(this.store.read(), section, limit);
        return { ok: true, content: content + '\n\n（wiki 文件：' + this.store.file + '）' };
    }

    /** wiki.update 工具：快照整体替换 + 条目只追加（设计 §9）。 */
    async updateForTool(args: WikiUpdateToolArgs = {}): Promise<WikiToolResult> {
        if (this.store === undefined) return { ok: false, error: 'wiki 未启用' };
        const written: string[] = [];
        const snapshot = typeof args.snapshot === 'string' ? args.snapshot.trim() : '';
        if (snapshot.length > 0) {
            if (!snapshot.includes('## ')) {
                return { ok: false, error: '快照需包含至少一个 markdown 二级标题（## …）' };
            }
            await this.store.writeSnapshot(snapshot);
            written.push('快照已替换');
        }
        const rawEntries =
            typeof args.entries === 'string'
                ? [args.entries]
                : Array.isArray(args.entries)
                  ? args.entries
                  : [];
        const changes = rawEntries
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
        if (changes.length > 0) {
            const now = new Date();
            const ts = formatTs(now);
            await this.store.appendEntries(changes.map((change) => ({ ts, change })));
            written.push('已追加 ' + changes.length + ' 条变更');
        }
        if (written.length === 0) return { ok: false, error: '未提供 snapshot 或 entries' };
        return { ok: true, content: written.join('；') + '（wiki 文件：' + this.store.file + '）' };
    }
}

function formatTs(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes()) +
        ':' +
        pad(date.getSeconds())
    );
}
