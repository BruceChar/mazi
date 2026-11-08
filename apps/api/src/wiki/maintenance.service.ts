import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { HarnessEvent } from '@mazi/core';
import {
    type GoalRunResult,
    ProjectWikiService,
    projectIdForWorkspace,
    type ProjectWikiSessionEndResult as RuntimeProjectWikiSessionEndResult,
    type ProjectWikiUpdatePlan as RuntimeProjectWikiUpdatePlan,
} from '@mazi/runtime';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

export type ProjectWikiOperationKind = 'init' | 'update' | 'sync';
export type ProjectWikiOperationState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ProjectWikiSessionSyncInput {
    rootGoalId: string;
    workspace: string;
    projectId: string;
    input: string;
    ok: boolean;
    summary: string;
}

export interface ProjectWikiOperationView {
    id: string;
    kind: ProjectWikiOperationKind;
    workspace: string;
    state: ProjectWikiOperationState;
    startedAt: number;
    finishedAt?: number;
    rootGoalId?: string;
    sourceSessionId?: string;
    summary?: string;
    error?: string;
    approvalPending?: boolean;
    lastHeartbeatAt?: number;
    trace?: Array<{
        timestamp: number;
        type: string;
        label: string;
    }>;
}

interface ProjectWikiUpdatePlan extends RuntimeProjectWikiUpdatePlan {
    research_files?: string[];
    source_session?: {
        rootGoalId: string;
        input: string;
        summary: string;
        ok: boolean;
        readCalls: number;
    };
}

type ProjectWikiSessionEndResult = RuntimeProjectWikiSessionEndResult & ProjectWikiUpdatePlan;

/**
 * Project Wiki 后台执行器。
 * 前台只读 INDEX；SessionEnd 的 sync 任务和页面按钮的 init/update 都在这里独立运行。
 */
@Injectable()
export class ProjectWikiMaintenanceService {
    private readonly operations = new Map<string, ProjectWikiOperationView>();
    private readonly syncQueues = new Map<string, Promise<void>>();

    constructor(private readonly runtime: ApiRuntimeService) {}

    start(
        kind: 'init' | 'update',
        workspace: string,
        options: {
            plan?: ProjectWikiUpdatePlan;
            sourceSessionId?: string;
        } = {},
    ): ProjectWikiOperationView {
        const running = this.current(workspace);
        if (running?.state === 'queued' || running?.state === 'running') {
            return { ...running };
        }
        const operation = this.createOperation(kind, workspace);
        if (options.sourceSessionId !== undefined) {
            operation.sourceSessionId = options.sourceSessionId;
        }
        void this.runMaintenance(operation, options.plan);
        return { ...operation };
    }

    /** SessionEnd 调用：立即入队，不阻塞当前会话。 */
    scheduleSessionSync(input: ProjectWikiSessionSyncInput): ProjectWikiOperationView {
        const operation = this.createOperation('sync', input.workspace, input.rootGoalId);
        this.addTrace(operation, 'sync.queued', `Session ${input.rootGoalId} 已入队`);
        operation.sourceSessionId = input.rootGoalId;
        const previous = this.syncQueues.get(input.workspace) ?? Promise.resolve();
        const queued = previous
            .catch(() => undefined)
            .then(async () => {
                operation.state = 'running';
                this.addTrace(operation, 'sync.running', '后台同步开始');
                try {
                    const result = await this.runSessionEnd(input, operation);
                    let summary = sessionEndSummary(result);
                    const research = await this.sessionResearch(input, operation);
                    if (result.needs_semantic_update === true || research.files.length > 0) {
                        const plan: ProjectWikiUpdatePlan = {
                            ...result,
                            no_changes: false,
                            needs_semantic_update: true,
                            ...(research.files.length > 0
                                ? {
                                      research_files: research.files,
                                      source_session: {
                                          rootGoalId: input.rootGoalId,
                                          input: input.input,
                                          summary: input.summary,
                                          ok: input.ok,
                                          readCalls: research.readCalls,
                                      },
                                  }
                                : {}),
                        };
                        const update = this.start('update', input.workspace, {
                            plan,
                            sourceSessionId: input.rootGoalId,
                        });
                        this.addTrace(
                            operation,
                            'sync.update-queued',
                            research.files.length > 0
                                ? `检测到 ${research.files.length} 个探索文件，已启动知识沉淀 ${update.id}`
                                : `检测到受影响事实，已启动增量更新 ${update.id}`,
                        );
                        summary +=
                            research.files.length > 0
                                ? '；已将探索结果交给后台知识沉淀'
                                : '；已启动后台语义更新';
                    }
                    operation.state = 'succeeded';
                    operation.summary = summary;
                } catch (error) {
                    operation.state = 'failed';
                    operation.error = errorMessage(error);
                } finally {
                    operation.finishedAt = Date.now();
                }
            })
            .finally(() => {
                if (this.syncQueues.get(input.workspace) === queued) {
                    this.syncQueues.delete(input.workspace);
                }
            });
        this.syncQueues.set(input.workspace, queued);
        return { ...operation };
    }

    get(operationId: string): ProjectWikiOperationView {
        const operation = this.operations.get(operationId);
        if (operation === undefined) throw new ApiError(404, 'Wiki 操作不存在');
        return { ...operation };
    }

    current(workspace: string): ProjectWikiOperationView | undefined {
        return this.latest(workspace, (operation) => operation.kind !== 'sync');
    }

    currentSync(workspace: string): ProjectWikiOperationView | undefined {
        return this.latest(workspace, (operation) => operation.kind === 'sync');
    }

    private async runMaintenance(
        operation: ProjectWikiOperationView,
        precomputedPlan?: ProjectWikiUpdatePlan,
    ): Promise<void> {
        operation.state = 'running';
        this.addTrace(
            operation,
            `${operation.kind}.running`,
            operation.kind === 'init' ? '初始化任务启动' : '增量检查启动',
        );
        let finalState: ProjectWikiOperationState = 'failed';
        let summary = '';
        let error = '';
        try {
            if (operation.kind === 'init' && this.isInitialized(operation.workspace)) {
                finalState = 'succeeded';
                summary = '项目 Wiki 已初始化，无需重复初始化';
                this.addTrace(operation, 'init.skipped', summary);
            } else if (operation.kind === 'update') {
                if (!this.isInitialized(operation.workspace)) {
                    throw new ApiError(409, '项目 Wiki 尚未初始化，请先执行初始化');
                }
                const plan =
                    precomputedPlan ?? (await this.incrementalUpdatePlan(operation.workspace));
                if (plan.no_changes) {
                    finalState = 'succeeded';
                    summary = '自上次 Wiki checkpoint 以来没有项目变化，无需更新';
                    this.addTrace(operation, 'update.skipped', summary);
                } else {
                    const result = await this.runAgent(
                        operation.kind,
                        operation.workspace,
                        operation,
                        plan,
                    );
                    finalState = result.ok ? 'succeeded' : 'failed';
                    operation.rootGoalId = result.rootGoalId;
                    summary = result.summary;
                    if (!result.ok) error = result.summary || 'Agent 执行失败';
                }
            } else {
                await this.ensureWiki(operation.workspace);
                const result = await this.runAgent(
                    operation.kind === 'init' ? 'init' : 'update',
                    operation.workspace,
                    operation,
                );
                finalState = result.ok ? 'succeeded' : 'failed';
                operation.rootGoalId = result.rootGoalId;
                summary = result.summary;
                if (!result.ok) error = result.summary || 'Agent 执行失败';
            }
        } catch (caught) {
            error = errorMessage(caught);
        } finally {
            try {
                await this.appendActivity(
                    operation,
                    operation.workspace,
                    operation.kind === 'init' ? '初始化项目 Wiki' : '更新项目 Wiki',
                    finalState === 'succeeded',
                    summary || error,
                );
            } catch (caught) {
                this.addTrace(
                    operation,
                    'activity.failed',
                    `维护记录写入失败：${errorMessage(caught)}`,
                );
            }
            operation.state = finalState;
            if (summary) operation.summary = summary;
            if (error) operation.error = error;
            operation.finishedAt = Date.now();
        }
    }

    private async runSessionEnd(
        input: ProjectWikiSessionSyncInput,
        operation: ProjectWikiOperationView,
    ): Promise<ProjectWikiSessionEndResult> {
        await this.ensureWiki(input.workspace);
        const result = (await this.projectWiki(input.workspace).sessionEnd({
            input: input.input,
            status: input.ok ? 'success' : 'failed',
            summary: input.summary,
        })) as ProjectWikiSessionEndResult;
        this.addTrace(operation, 'activity.recorded', `会话活动已写入 ${result.activity.at}`);
        this.addTrace(
            operation,
            'sync.plan',
            result.no_changes
                ? '增量检测：工作区没有项目文件变化'
                : `增量检测：${result.changed_files.length} 个变更文件，${result.claims.length} 条受影响 claim`,
        );
        return result;
    }

    private async sessionResearch(
        input: ProjectWikiSessionSyncInput,
        operation: ProjectWikiOperationView,
    ): Promise<{ files: string[]; readCalls: number }> {
        try {
            const snapshot = await this.runtime.harness().goalSnapshot(input.rootGoalId);
            const research = researchFromSnapshot(input.workspace, snapshot);
            if (
                research.files.length > 0 &&
                (input.summary.trim().length >= 320 || research.readCalls >= 6)
            ) {
                this.addTrace(
                    operation,
                    'sync.research-detected',
                    `探索 ${research.readCalls} 次，候选知识文件 ${research.files.length} 个`,
                );
                return research;
            }
            return { files: [], readCalls: research.readCalls };
        } catch (error) {
            this.addTrace(
                operation,
                'sync.research-skipped',
                `读取会话 trace 失败：${errorMessage(error)}`,
            );
            return { files: [], readCalls: 0 };
        }
    }

    private async ensureWiki(workspace: string): Promise<void> {
        const wiki = this.projectWiki(workspace);
        if (!wiki.isInitialized()) await wiki.init();
    }

    private isInitialized(workspace: string): boolean {
        return this.projectWiki(workspace).isInitialized();
    }

    private async incrementalUpdatePlan(workspace: string): Promise<ProjectWikiUpdatePlan> {
        return (await this.projectWiki(workspace).updatePlan()) as ProjectWikiUpdatePlan;
    }

    private async appendActivity(
        operation: ProjectWikiOperationView,
        workspace: string,
        input: string,
        ok: boolean,
        summary: string,
    ): Promise<void> {
        await this.ensureWiki(workspace);
        await this.projectWiki(workspace).record({
            input,
            status: ok ? 'success' : 'failed',
            summary,
        });
        this.addTrace(operation, 'activity.recorded', '会话活动已写入 state/current.md');
    }

    private async runAgent(
        kind: 'init' | 'update',
        workspace: string,
        operation: ProjectWikiOperationView,
        updatePlan?: ProjectWikiUpdatePlan,
    ): Promise<{ rootGoalId: string; ok: boolean; summary: string }> {
        this.runtime.setWorkspaceRoot(workspace);
        const skills = await this.runtime.skills();
        const mounted = skills.mounted();
        const effective = (await this.runtime.features()).resolve();
        const skillIds = [...new Set(mounted)];
        const promptFragment = effective.promptFragment;
        this.addTrace(operation, 'agent.started', '后台维护 Agent 启动');
        const created = await this.runtime
            .harness()
            .createGoalSession(projectWikiPrompt(kind, updatePlan), {
                workspaceRoot: workspace,
                projectId: projectIdForWorkspace(workspace),
                permissionCeiling: 'workspace-write',
                parseIntent: false,
                taskPlanning: false,
                skillIds,
                allowedTools: ['fs.read', 'rg', 'fd', 'bat', 'cat', 'ls', 'project_wiki'],
                reasoningLevel: kind === 'update' ? 'medium' : 'high',
                maxSteps:
                    kind === 'update' && updatePlan !== undefined
                        ? updateAgentStepBudget(updatePlan)
                        : 24,
                ...(promptFragment.length > 0 ? { promptFragment } : {}),
                ...(Object.keys(effective.values).length > 0
                    ? { flagOverrides: effective.values }
                    : {}),
                ...(effective.trace.length > 0 ? { flagTrace: effective.trace } : {}),
            });
        operation.rootGoalId = created.rootGoalId;
        this.addTrace(operation, 'goal.created', `后台 Goal ${created.rootGoalId}`);
        const unsubscribe = this.runtime.harness().eventBus.subscribe(
            {},
            {
                id: `wiki-operation-${operation.id}`,
                handle: (event) => {
                    if (event.rootGoalId !== operation.rootGoalId) return;
                    if (event.type === 'llm.stream_event') {
                        operation.lastHeartbeatAt = event.timestamp;
                        return;
                    }
                    if (event.type === 'approval.requested') {
                        operation.approvalPending = true;
                    } else if (
                        event.type === 'approval.granted' ||
                        event.type === 'approval.cancelled'
                    ) {
                        operation.approvalPending = false;
                    }
                    this.addTrace(operation, event.type, traceEventLabel(event), event.timestamp);
                },
            },
        );
        const result = await this.runtime
            .runBackgroundExclusive(() =>
                this.runtime.harness().executeGoalTree(created.rootGoalId),
            )
            .finally(unsubscribe);
        const hasFinalAnswer = (result.tasks.at(-1)?.finalMessage?.trim().length ?? 0) > 0;
        const checkpointCompleted =
            !result.ok &&
            hasFinalAnswer &&
            (await this.checkpointCompletedSince(workspace, operation.startedAt));
        if (checkpointCompleted) {
            this.addTrace(
                operation,
                'agent.completed-with-warnings',
                '工具步骤存在错误，但 Wiki checkpoint 已完成',
            );
        }
        return {
            rootGoalId: created.rootGoalId,
            ok: result.ok || checkpointCompleted,
            summary: resultSummary(result),
        };
    }

    private async checkpointCompletedSince(workspace: string, since: number): Promise<boolean> {
        return this.projectWiki(workspace).checkpointCompletedSince(since);
    }

    private projectWiki(workspace: string): ProjectWikiService {
        return new ProjectWikiService({ workspace });
    }

    private createOperation(
        kind: ProjectWikiOperationKind,
        workspace: string,
        rootGoalId?: string,
    ): ProjectWikiOperationView {
        const operation: ProjectWikiOperationView = {
            id: randomUUID(),
            kind,
            workspace,
            state: 'queued',
            startedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            trace: [],
            ...(rootGoalId !== undefined ? { sourceSessionId: rootGoalId } : {}),
        };
        this.operations.set(operation.id, operation);
        this.prune();
        return operation;
    }

    private addTrace(
        operation: ProjectWikiOperationView,
        type: string,
        label: string,
        timestamp = Date.now(),
    ): void {
        operation.lastHeartbeatAt = timestamp;
        operation.trace = [...(operation.trace ?? []), { timestamp, type, label }].slice(-60);
    }

    private latest(
        workspace: string,
        predicate: (operation: ProjectWikiOperationView) => boolean,
    ): ProjectWikiOperationView | undefined {
        return [...this.operations.values()]
            .filter((operation) => operation.workspace === workspace && predicate(operation))
            .sort((left, right) => right.startedAt - left.startedAt)[0];
    }

    private prune(): void {
        const completed = [...this.operations.values()]
            .filter((operation) => operation.state === 'succeeded' || operation.state === 'failed')
            .sort((left, right) => left.startedAt - right.startedAt);
        for (const operation of completed.slice(0, Math.max(0, completed.length - 40))) {
            this.operations.delete(operation.id);
        }
    }
}

function resultSummary(result: GoalRunResult): string {
    return (
        result.rejected?.join(';').trim() ||
        result.tasks.at(-1)?.finalMessage?.trim().slice(0, 1200) ||
        (result.ok ? '项目 Wiki 已更新' : '项目 Wiki 维护失败')
    );
}

interface ResearchSnapshot {
    goals?: Array<{
        tasks?: Array<{
            steps?: Array<{
                kind?: string;
                toolName?: string;
                toolArguments?: unknown;
            }>;
        }>;
    }>;
}

const RESEARCH_READ_TOOLS = new Set([
    'fs.read',
    'cat',
    'bat',
    'rg',
    'fd',
    'eza',
    'ls',
    'shell.run',
]);
const RESEARCH_FILE_EXTENSIONS = new Set([
    '.md',
    '.txt',
    '.json',
    '.toml',
    '.yaml',
    '.yml',
    '.py',
    '.js',
    '.mjs',
    '.cjs',
    '.ts',
    '.tsx',
    '.vue',
    '.sh',
    '.rs',
    '.go',
    '.java',
    '.kt',
    '.css',
    '.html',
    '.xml',
    '.ini',
    '.cfg',
    '.conf',
]);

function researchFromSnapshot(
    workspace: string,
    snapshot: unknown,
): { files: string[]; readCalls: number } {
    const data = snapshot as ResearchSnapshot;
    const files = new Set<string>();
    let readCalls = 0;
    for (const goal of data.goals ?? []) {
        for (const task of goal.tasks ?? []) {
            for (const step of task.steps ?? []) {
                if (step.kind !== 'invocation' || typeof step.toolName !== 'string') continue;
                if (!RESEARCH_READ_TOOLS.has(step.toolName)) continue;
                const candidates = researchCandidates(step.toolName, step.toolArguments);
                if (
                    candidates.length > 0 ||
                    step.toolName === 'fd' ||
                    step.toolName === 'eza' ||
                    step.toolName === 'ls'
                ) {
                    readCalls += 1;
                }
                for (const candidate of candidates) {
                    const safe = safeResearchFile(workspace, candidate);
                    if (safe !== undefined) files.add(safe);
                    if (files.size >= 20) break;
                }
                if (files.size >= 20) break;
            }
        }
    }
    return { files: [...files].sort(), readCalls };
}

function researchCandidates(toolName: string, rawArgs: unknown): string[] {
    const args =
        rawArgs !== null && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
    if (toolName === 'shell.run') {
        const command = typeof args.command === 'string' ? args.command : '';
        return [
            ...command.matchAll(
                /[\w@./-]+\.(?:md|txt|json|toml|ya?ml|py|m?js|cjs|tsx?|vue|sh|rs|go|java|kt|css|html|xml|ini|cfg|conf)/gi,
            ),
        ]
            .map((match) => match[0])
            .filter((value) => !value.startsWith('-'));
    }
    for (const key of ['path', 'file', 'filePath', 'file_path', 'target']) {
        if (typeof args[key] === 'string') return [args[key]];
    }
    return [];
}

function safeResearchFile(workspace: string, candidate: string): string | undefined {
    const cleaned = candidate.trim().replace(/^['"]|['"),;:]$/g, '');
    if (cleaned.length === 0) return undefined;
    const absolute = resolve(workspace, cleaned);
    const relativePath = relative(workspace, absolute).replace(/\\/g, '/');
    if (
        relativePath.length === 0 ||
        relativePath === '..' ||
        relativePath.startsWith('../') ||
        !isKnowledgePath(relativePath)
    ) {
        return undefined;
    }
    try {
        return statSync(absolute).isFile() ? relativePath : undefined;
    } catch {
        return undefined;
    }
}

function isKnowledgePath(relativePath: string): boolean {
    const segments = relativePath.split('/');
    if (
        ['wiki', 'data', 'node_modules', '.git', 'dist', 'build', 'target', '__pycache__'].includes(
            segments[0] ?? '',
        )
    ) {
        return false;
    }
    if (
        segments.some((segment) =>
            ['raw', 'logs', 'node_modules', '.cache', '__pycache__'].includes(segment),
        )
    ) {
        return false;
    }
    const name = segments.at(-1) ?? '';
    if (name.startsWith('.env')) return false;
    const dot = name.lastIndexOf('.');
    return dot >= 0 && RESEARCH_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function traceEventLabel(event: HarnessEvent): string {
    const payload =
        event.payload !== null && typeof event.payload === 'object'
            ? (event.payload as Record<string, unknown>)
            : {};
    if (event.type === 'task.started') {
        return `Task：${textValue(payload.title) || textValue(payload.taskId) || event.type}`;
    }
    if (event.type === 'step.started') {
        const kind = textValue(payload.kind) || 'step';
        const calls = Array.isArray(payload.toolCalls)
            ? payload.toolCalls
                  .map((call) =>
                      call !== null && typeof call === 'object'
                          ? textValue((call as Record<string, unknown>).name)
                          : '',
                  )
                  .filter(Boolean)
            : [];
        return calls.length > 0 ? `${kind}：${calls.join(', ')}` : kind;
    }
    if (event.type === 'tool.invoke' || event.type === 'tool.result') {
        return `${event.type}：${textValue(payload.toolName) || textValue(payload.name) || '-'}`;
    }
    if (event.type === 'verification.completed') {
        return `核验：${textValue(payload.state) || '-'}`;
    }
    if (event.type === 'goal.ended') {
        const outcome =
            payload.outcome !== null && typeof payload.outcome === 'object'
                ? (payload.outcome as Record<string, unknown>)
                : {};
        return `Goal 结束：${textValue(outcome.status) || '-'}`;
    }
    if (event.type === 'llm.error') {
        return `模型错误：${textValue(payload.message) || '-'}`;
    }
    if (event.type === 'approval.requested') {
        const tool = textValue(payload.tool);
        const summary = textValue(payload.summary);
        return `等待审批：${tool || '工具'}${summary ? ` · ${summary}` : ''}`;
    }
    if (event.type === 'approval.granted') return '审批已通过';
    if (event.type === 'approval.cancelled') return '审批已取消 / 超时';
    return event.type;
}

function textValue(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, 160) : '';
}

function projectWikiPrompt(kind: 'init' | 'update', updatePlan?: ProjectWikiUpdatePlan): string {
    const shared = [
        '## 后台 Wiki 任务',
        '这是后台维护任务。直接执行，不要向用户确认，也不要创建待办后停下。',
        'Project Wiki 由 runtime 内置维护；项目内容来自当前 workspace。',
        '本任务没有 shell.run 或通用项目写工具。读取使用 fs.read/rg/fd/bat/cat/ls；所有 Wiki 写入使用 project_wiki 结构化 action。',
        '可用事实必须挂 evidence；无法确认的内容保留 TODO，禁止臆测。',
        '最终回答只给机器可读的简短摘要，不要写成面向用户的对话。',
    ];
    if (kind === 'init') {
        return [
            '初始化当前项目的知识库。',
            ...shared,
            '1. 骨架已经由 runtime 创建，不要再次 init。',
            '2. 首轮并行读取 README 与包/工作区清单；AGENTS.md 较大时先用 rg 找目标、部署、红线、命令等标题，只读命中段落。最多选择 8 个关键文件，不要遍历 data/、日志、缓存或整库。',
            '3. 读取 2-3 个代表性入口（例如 server、CLI、部署或定时脚本）后必须开始写库，不得持续扩大到全项目。',
            '4. 用 `project_wiki` 的 `action:"write_doc"` 填写最相关的 architecture / commands / deployment、INDEX 摘要与 state/current；保留已有确认内容。',
            '5. 用 `action:"claim_add"` 建立 3-8 条高价值 claims，evidence 只指向已读的真实文件；随后执行一次 `action:"checkpoint"`。',
        ].join('\n');
    }
    if (kind === 'update') {
        const changedFiles = updatePlan?.changed_files.join(', ') || '无';
        const claimIds = updatePlan?.claims.map((claim) => claim.id).join(', ') || '无';
        const researchFiles = updatePlan?.research_files ?? [];
        if (researchFiles.length > 0) {
            const source = updatePlan?.source_session;
            return [
                '把一次已结束探索会话中获得的项目知识沉淀到 Wiki。',
                ...shared,
                `用户问题：${source?.input ?? '-'}`,
                `会话结论（可能被截断，仅作检索线索）：\n${source?.summary ?? '-'}`,
                `前台会话实际读取过的安全项目文件：\n${researchFiles.map((file) => `- ${file}`).join('\n')}`,
                `结构化清单：\n${JSON.stringify(updatePlan ?? {}, null, 2)}`,
                '1. 这是只读探索会话，可能没有任何 git diff；不要因此判定“无需更新”。只围绕 research_files 和会话结论核实可复用事实，不要重新遍历项目。',
                '2. 不复制整段回答，不记录问题原文或对话流水。优先填写对应 overview 文档（部署问题更新 deployment，结构问题更新 architecture，流程问题更新 commands），INDEX 仍是 TODO 时补项目摘要与路由。',
                '3. 先用 `rg` 在 wiki/claims.toml 与相关 wiki 文档中查重；只新增能改变后续行动、且不会从单个文件一眼看出的 claims；每条 evidence 必须指向 research_files 中实际存在的文件。已有事实用 claim_verify/claim_update；事实被纠正时使用 claim_correct，使旧事实退出后续上下文；明确遗忘使用 claim_forget。',
                '4. 每个需要精读的文件最多读取一次；大文件用 rg 定位相关段落后再读局部。',
                '5. 完成后执行一次 `action:"checkpoint"`；即使最终判断没有新增事实，也要用简短摘要说明为什么。',
            ].join('\n');
        }
        return [
            '检查项目自上次 checkpoint 以来的变化并更新知识库。',
            ...shared,
            `结构化增量清单：\n${JSON.stringify(updatePlan ?? {}, null, 2)}`,
            `变更文件：${changedFiles}`,
            `受影响 claims：${claimIds}`,
            '1. 清单已经由 git diff/status 与 oid 反查生成，是本次唯一工作范围。不要重新请求 update_plan，不要遍历项目；优先在一个模型轮次并行读取全部 changed_files，并确保每个文件最多读取一次。',
            '2. 逐条判断受影响 claim：仍成立就待批量核验；语义被修正用 claim_correct 创建替代事实并遗忘旧事实；直接失效用 claim_update；明确不再需要记住则 claim_forget。除非清单 evidence 缺失，不要读取登记之外的源文件。',
            '3. 所有仍成立的 claim 只能调用一次 `project_wiki` 的 `action:"claim_verify"` 并传 ids 数组，禁止逐条 verify。',
            '4. 只有出现可复用的结构或工作流变化时才更新一个最相关的 wiki Markdown；不要为了写满内容而重写整库。',
            '5. 最后只执行一次 `action:"checkpoint"`。不要再跑全量 doctor（checkpoint 已包含校验），也不要重复读取已处理文件。',
        ].join('\n');
    }
    return ['初始化当前项目的知识库。', ...shared].join('\n');
}

function updateAgentStepBudget(plan: ProjectWikiUpdatePlan): number {
    const files = Math.max(1, plan.changed_files.length);
    const batches = Math.ceil(plan.claims.length / 4);
    const researchFiles = plan.research_files?.length ?? 0;
    if (researchFiles > 0) {
        return Math.min(28, Math.max(18, 10 + Math.min(10, researchFiles)));
    }
    return Math.min(24, Math.max(12, files * 2 + batches + 8));
}

function sessionEndSummary(result: ProjectWikiSessionEndResult): string {
    const affected = result.claims.length;
    const files = result.changed_files.length;
    if (result.no_changes) return '会话活动已记录；未检测到项目文件变化';
    if (result.needs_semantic_update === true) {
        return `会话活动已记录；检测到 ${files} 个变更文件、${affected} 条受影响事实`;
    }
    return `会话活动已记录；检测到 ${files} 个变更文件，事实 oid 均一致`;
}
