import { dirname } from 'node:path';
import type { authz, Goal, PermissionLevel, ToolSchema } from '@mazi/core';
import type { AgentRoleRegistry } from '../agent/roles.js';
import type { SkillProvider } from '../capabilities/runtime.js';
import type { RuntimeConfig, ToolCallResult, ToolConfig } from '../config.js';
import type { DefaultEventBus } from '../events/event-bus.js';
import type { FaultPipeline } from '../faults/index.js';
import type { PlanTool } from '../gts/plan-graph.js';
import type { HookRunner } from '../hooks/index.js';
import { permissionForTool, RuntimeToolGateway } from '../tool-gateway/permission.js';
import { RuntimePolicyAuditSink } from '../tool-gateway/policy-audit.js';
import type { RuntimeToolRegistry } from '../tool-gateway/registry.js';
import type { ProjectWikiService, WikiService } from '../wiki/index.js';
import { projectWikiToolConfig, wikiToolConfigs } from './tool-configs.js';
import { ToolInvoker } from './tool-invoker.js';
import { deepseekSearchOptions, webSearchToolConfig } from './web-search.js';

/**
 * ToolPlane —— 工具面装配（从 HarnessRuntime 抽出）。
 *
 * 只负责"本轮暴露哪些工具、经哪个网关、用哪个 invoker"，不执行工具本身：
 * 执行经 `execute` 端口回到宿主（那里才有 effect 快照、沙箱与 CLI 策略）。
 */

export interface ToolPlaneExecuteContext {
    identifiers?: import('@mazi/core').AuditIdentifiers;
}

export interface ToolPlaneDeps {
    config: RuntimeConfig;
    toolRegistry: RuntimeToolRegistry;
    workspaceRoot?: string;
    hooks: HookRunner;
    faults: FaultPipeline;
    bus: DefaultEventBus;
    approvalStore: authz.ApprovalStore;
    commandPolicy: authz.CommandPolicy;
    projectWiki?: ProjectWikiService | (() => ProjectWikiService | undefined);
    /** wiki 服务；传函数时延迟解析。 */
    wiki: WikiService | (() => WikiService);
    /** 角色注册表；传函数时延迟解析（delegation 模块关闭时返回 undefined）。 */
    delegationRoles: AgentRoleRegistry | (() => AgentRoleRegistry | undefined);
    /** 可变接入点：运行期由宿主 setter 更换。 */
    getSkillProvider: () => SkillProvider | undefined;
    getApprovalSeam: () => authz.ApprovalSeam | undefined;
    /** 实际执行（effect 快照/沙箱/CLI 均在宿主侧）。 */
    execute: (
        tool: ToolConfig,
        args: Record<string, unknown>,
        ctx: ToolPlaneExecuteContext | undefined,
        skillReadRoots: readonly string[],
    ) => Promise<ToolCallResult>;
    /** delegate 工具的落点（编排在宿主，工具面只声明 schema）。 */
    delegate: (input: {
        rootGoalId: string;
        parentGoal: Goal;
        args: Record<string, unknown>;
        projectId?: string;
        userId?: string;
        delegationDepth: number;
    }) => Promise<ToolCallResult>;
}

export interface ToolPlaneInput {
    rootGoalId: string;
    goalId: string;
    level: PermissionLevel;
    sessionId?: string;
    allowedToolsOverride?: readonly string[];
    projectId?: string;
    parentGoal?: Goal;
    userId?: string;
    delegationDepth?: number;
    activeSkillIds?: readonly string[];
    /** 干净上下文：不暴露项目黑板工具（实验默认）。 */
    freshContext?: boolean;
}

export interface ToolPlaneOutput {
    tools: ToolSchema[];
    invoker: import('../gts/goal-executor.js').GoalToolInvoker;
    allowedTools: string[];
    planTools: PlanTool[];
    toolsetVersion: number;
    toolsetDigest: string;
}

export class ToolPlane {
    private roles(): AgentRoleRegistry | undefined {
        const dep = this.deps.delegationRoles;
        return typeof dep === 'function' ? dep() : dep;
    }

    /** wiki 服务：传函数时延迟解析，避免装配期触发目录探测。 */
    private wiki(): WikiService {
        const dep = this.deps.wiki;
        return typeof dep === 'function' ? dep() : dep;
    }

    private webSearchOptions(): { deepseek?: ReturnType<typeof deepseekSearchOptions> } {
        for (const provider of this.deps.config.providers) {
            const deepseek = deepseekSearchOptions(provider);
            if (deepseek !== undefined) return { deepseek };
        }
        return {};
    }

    private projectWiki(): ProjectWikiService | undefined {
        const dep = this.deps.projectWiki;
        return typeof dep === 'function' ? dep() : dep;
    }

    constructor(private readonly deps: ToolPlaneDeps) {}

    /** 装配本轮工具面：快照 → 注入 wiki/delegate → 网关 → invoker。 */
    config(input: ToolPlaneInput): ToolPlaneOutput {
        const { deps } = this;
        const toolSnapshot = deps.toolRegistry.snapshot();
        const skillReadRoots = this.skillReadRoots(
            input.rootGoalId,
            input.goalId,
            input.activeSkillIds ?? [],
        );
        const merged: ToolConfig[] = toolSnapshot.tools;
        merged.push(webSearchToolConfig(this.webSearchOptions()));
        const projectWiki = this.projectWiki();
        if (projectWiki !== undefined) {
            merged.push(projectWikiToolConfig(projectWiki));
        } else {
            const wiki = this.wiki();
            if (wiki.enabled) merged.push(...wikiToolConfigs(wiki));
        }
        const depth = input.delegationDepth ?? 0;
        if (input.parentGoal !== undefined && depth < 2) {
            merged.push(
                this.delegateToolConfig(
                    input.rootGoalId,
                    input.parentGoal,
                    input.projectId,
                    input.userId,
                    depth,
                ),
            );
        }
        const approvalSeam = deps.getApprovalSeam();
        const gateway = new RuntimeToolGateway({
            rootGoalId: input.rootGoalId,
            goalId: input.goalId,
            taskId: input.goalId,
            level: input.level,
            tools: merged,
            execute: (tool, args, ctx) => deps.execute(tool, args, ctx, skillReadRoots),
            ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot } : {}),
            audit: new RuntimePolicyAuditSink({ emit: (event) => deps.bus.emit(event) }),
            ...(approvalSeam !== undefined ? { approval: approvalSeam } : {}),
            approvalStore: deps.approvalStore,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            commandPolicy: deps.commandPolicy,
        });
        const visible = new Set(gateway.visibleToolNames());
        const configured = deps.config.goal?.allowedTools;
        const visibleNames = configured === undefined ? merged.map((t) => t.name) : configured;
        // 运行级白名单只收窄：与配置白名单取交集（显式空数组 = 本次不暴露任何工具）。
        const names = (
            input.allowedToolsOverride === undefined
                ? visibleNames
                : visibleNames.filter((name) => input.allowedToolsOverride?.includes(name))
        ).filter((name) => visible.has(name));
        const tools: ToolSchema[] = merged
            .filter((t) => names.includes(t.name))
            .map((t) => ({
                name: t.name,
                description: t.description,
                parameters: (t.parameters ?? undefined) as ToolSchema['parameters'],
            }));
        const invoker = new ToolInvoker({
            rootGoalId: input.rootGoalId,
            goalId: input.goalId,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            gateway,
            hooks: deps.hooks,
            faults: deps.faults,
        });
        return {
            tools,
            invoker,
            allowedTools: names,
            planTools: merged
                .filter((tool) => names.includes(tool.name))
                .map((tool) => ({ name: tool.name, minPermission: permissionForTool(tool) })),
            toolsetVersion: toolSnapshot.version,
            toolsetDigest: toolSnapshot.digest,
        };
    }

    private delegateToolConfig(
        rootGoalId: string,
        parentGoal: Goal,
        projectId: string | undefined,
        userId: string | undefined,
        delegationDepth: number,
    ): ToolConfig {
        return {
            name: 'delegate',
            description:
                'Delegate independent sub-goals to specialized agents. All proposals are validated against parent permission and budget before parallel execution. Results return as observations.',
            parameters: {
                type: 'object',
                properties: {
                    delegations: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                statement: { type: 'string' },
                                roleId: {
                                    type: 'string',
                                    enum:
                                        this.roles()
                                            ?.list()
                                            .map((role) => role.roleId) ?? [],
                                },
                                ceiling: { type: 'string' },
                                budget: { type: 'object' },
                            },
                            required: ['statement', 'roleId'],
                        },
                    },
                },
                required: ['delegations'],
            },
            minPermission: 'read-only',
            sideEffects: [],
            impl: async (args) =>
                this.deps.delegate({
                    rootGoalId,
                    parentGoal,
                    args,
                    ...(projectId !== undefined ? { projectId } : {}),
                    ...(userId !== undefined ? { userId } : {}),
                    delegationDepth,
                }),
        };
    }

    private skillReadRoots(
        rootGoalId: string,
        goalId: string,
        skillIds: readonly string[],
    ): string[] {
        const provider = this.deps.getSkillProvider();
        const context = { rootGoalId, goalId };
        const entries =
            provider?.catalogFor?.(skillIds, context) ??
            (provider?.catalog(context) ?? []).filter((entry) => skillIds.includes(entry.id));
        return [...new Set(entries.map((entry) => dirname(entry.path)))];
    }
}
