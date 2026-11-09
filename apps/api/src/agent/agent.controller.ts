import 'reflect-metadata';
import {
    type AgentPromptView,
    type AgentRole,
    type PromptPack,
    type PromptRiskLevel,
    type PromptTaskKind,
} from '@mazi/runtime';
import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

function strings(value: unknown): string[] | undefined {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : undefined;
}

const TASK_KINDS = new Set<PromptTaskKind>([
    'general',
    'coding',
    'debug',
    'research',
    'data',
    'memory',
    'security',
]);
const RISK_LEVELS = new Set<PromptRiskLevel>([
    'read-only',
    'workspace-write',
    'external',
    'irreversible',
]);

function packOf(body: Record<string, unknown>): PromptPack {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const module = typeof body.module === 'string' ? body.module.trim() : '';
    if (!id || !name || !description || !module) {
        throw new ApiError(400, 'id/name/description/module 必填');
    }
    const matcher =
        typeof body.matcher === 'object' && body.matcher !== null
            ? (body.matcher as Record<string, unknown>)
            : {};
    const rawTaskKinds = strings(matcher.taskKinds);
    const rawRiskLevels = strings(matcher.riskLevels);
    return {
        id,
        name,
        description,
        version: typeof body.version === 'number' ? Math.max(1, body.version) : 1,
        ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        matcher: {
            ...(strings(matcher.projectIds) !== undefined
                ? { projectIds: strings(matcher.projectIds) }
                : {}),
            ...(strings(matcher.projectTags) !== undefined
                ? { projectTags: strings(matcher.projectTags) }
                : {}),
            ...(rawTaskKinds !== undefined
                ? {
                      taskKinds: rawTaskKinds.filter((kind): kind is PromptTaskKind =>
                          TASK_KINDS.has(kind as PromptTaskKind),
                      ),
                  }
                : {}),
            ...(strings(matcher.toolNeeds) !== undefined
                ? { toolNeeds: strings(matcher.toolNeeds) }
                : {}),
            ...(rawRiskLevels !== undefined
                ? {
                      riskLevels: rawRiskLevels.filter((risk): risk is PromptRiskLevel =>
                          RISK_LEVELS.has(risk as PromptRiskLevel),
                      ),
                  }
                : {}),
        },
        module,
        ...(strings(body.projectRules) !== undefined
            ? { projectRules: strings(body.projectRules) }
            : {}),
        ...(strings(body.examples) !== undefined ? { examples: strings(body.examples) } : {}),
        ...(typeof body.budgetTokens === 'number'
            ? { budgetTokens: Math.max(1, body.budgetTokens) }
            : {}),
        ...(strings(body.conflictsWith) !== undefined
            ? { conflictsWith: strings(body.conflictsWith) }
            : {}),
        ...(typeof body.evalBaselineRef === 'string'
            ? { evalBaselineRef: body.evalBaselineRef }
            : {}),
    };
}

@Controller('agent')
export class AgentController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    @Get('prompt-packs')
    promptPacks() {
        return { packs: this.runtime.harness().promptPackRegistry().list() };
    }

    @Post('prompt-packs')
    registerPromptPack(@Body() body: Record<string, unknown>) {
        const pack = packOf(body);
        this.runtime.harness().registerPromptPack(pack);
        return { pack };
    }

    @Delete('prompt-packs/:id')
    removePromptPack(@Param('id') id: string) {
        const removed = this.runtime.harness().promptPackRegistry().remove(id);
        if (!removed) throw new ApiError(404, 'PromptPack 不存在');
        return { ok: true, removed };
    }

    @Post('preview')
    preview(@Body() body: Record<string, unknown>) {
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) throw new ApiError(400, '缺少 input');
        const taskKind =
            typeof body.taskKind === 'string' && TASK_KINDS.has(body.taskKind as PromptTaskKind)
                ? (body.taskKind as PromptTaskKind)
                : undefined;
        const riskLevel =
            typeof body.riskLevel === 'string' && RISK_LEVELS.has(body.riskLevel as PromptRiskLevel)
                ? (body.riskLevel as PromptRiskLevel)
                : undefined;
        const decision = this.runtime.harness().previewSuperAgent({
            input,
            ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
            ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
            ...(typeof body.workspace === 'string' ? { workspace: body.workspace } : {}),
            ...(strings(body.tools) !== undefined ? { tools: strings(body.tools) } : {}),
            ...(strings(body.projectTags) !== undefined
                ? { projectTags: strings(body.projectTags) }
                : {}),
            ...(strings(body.explicitPackIds) !== undefined
                ? { explicitPackIds: strings(body.explicitPackIds) }
                : {}),
            ...(riskLevel !== undefined ? { riskLevel } : {}),
            ...(taskKind !== undefined ? { taskKind } : {}),
        });
        return { decision };
    }

    @Get('verifier')
    verifier() {
        return this.runtime.harness().verifierInfo();
    }

    @Get('roles')
    roles() {
        return { roles: this.runtime.harness().agentRoles() };
    }

    @Post('roles')
    registerRole(@Body() body: Record<string, unknown>) {
        const roleId = typeof body.roleId === 'string' ? body.roleId.trim() : '';
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        if (!roleId || !label) throw new ApiError(400, 'roleId/label 必填');
        const role: AgentRole = {
            roleId,
            label,
            ...(typeof body.modelId === 'string' ? { modelId: body.modelId } : {}),
            ...(strings(body.tools) !== undefined ? { tools: strings(body.tools) } : {}),
            ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
            ...(typeof body.defaultCeiling === 'string'
                ? { defaultCeiling: body.defaultCeiling as AgentRole['defaultCeiling'] }
                : {}),
            memoryPolicy: body.memoryPolicy === 'isolated' ? 'isolated' : 'inherit',
        };
        this.runtime.harness().registerAgentRole(role);
        return { role };
    }

    @Delete('roles/:id')
    removeRole(@Param('id') roleId: string) {
        if (!this.runtime.harness().removeAgentRole(roleId)) {
            throw new ApiError(404, 'Agent role 不存在');
        }
        return { ok: true, removed: true };
    }

    @Get('prompts')
    prompts(): { prompts: AgentPromptView[] } {
        return { prompts: this.runtime.agentPromptViews() };
    }

    /** 保存某 Agent 的系统提示（空字符串 = 恢复默认）；下一次新建会话生效。 */
    @Put('prompts/:id')
    async savePrompt(
        @Param('id') id: string,
        @Body() body: Record<string, unknown>,
    ): Promise<{ prompt: AgentPromptView }> {
        if (typeof body?.systemPrompt !== 'string') {
            throw new ApiError(400, 'systemPrompt 必须是字符串');
        }
        return { prompt: await this.runtime.setAgentPrompt(id, body.systemPrompt) };
    }

    /** 恢复某 Agent 的内置默认提示。 */
    @Delete('prompts/:id')
    async resetPrompt(@Param('id') id: string): Promise<{ ok: true; prompt: AgentPromptView }> {
        return { ok: true, prompt: await this.runtime.setAgentPrompt(id, '') };
    }

    @Get('sessions/:id/delegations')
    async delegations(@Param('id') rootGoalId: string) {
        return { edges: await this.runtime.harness().delegationEdges(rootGoalId) };
    }
}
