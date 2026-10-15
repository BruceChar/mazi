import 'reflect-metadata';
import type {
    SkillDetailView,
    SkillRuntime,
    SkillView,
    WritableSkillRootScope,
} from '@mazi/runtime';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** 发现面：根（scope + dir）+ 技能列表（含挂载与使用情况）+ 装载错误 + 被覆盖来源 + 汇总。 */
async function discoveryOf(skills: SkillRuntime): Promise<Record<string, unknown>> {
    return {
        roots: skills.registry.roots,
        skills: skills.list(),
        errors: skills.errors(),
        shadowed: skills.shadowed(),
        usage: skills.usageSummary(),
    };
}

/** 新建技能入参（scope 缺省 user；builtin 只读）。 */
function createSkillInputOf(body: unknown): {
    id: string;
    name: string;
    description?: string;
    scope: WritableSkillRootScope;
} {
    if (typeof body !== 'object' || body === null) throw new ApiError(400, '缺少请求体');
    const record = body as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (id.length === 0) throw new ApiError(400, 'id 必填（kebab-case）');
    if (name.length === 0) throw new ApiError(400, 'name 必填');
    const scope = record.scope === undefined ? 'user' : record.scope;
    if (scope !== 'user' && scope !== 'project') {
        throw new ApiError(400, 'scope 只支持 user | project（builtin 只读）');
    }
    return {
        id,
        name,
        ...(typeof record.description === 'string' && record.description.trim().length > 0
            ? { description: record.description.trim() }
            : {}),
        scope,
    };
}

/**
 * Skill（SKILL.md）管理：**发现 + 新建 + 挂载 / 卸载**（docs/能力包规范.md §6）。
 * Skill 是用户资产（<workspace>/skills、$MAZI_HOME/skills；内置根只读），不进代码仓库；
 * 挂载状态持久化在 $MAZI_HOME/skills.json，挂载只影响 catalog 注入，不改变工具面与权限。
 */
@Controller('capabilities')
export class CapabilitiesController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** GET /api/capabilities：列出 skills 根下的技能与挂载状态。 */
    @Get()
    async list(): Promise<Record<string, unknown>> {
        return discoveryOf(await this.runtime.skills());
    }

    /** POST /api/capabilities：新建 Skill（写 SKILL.md 脚手架 + 立即发现）；重名 → 409。 */
    @Post()
    async create(@Body() body: unknown): Promise<SkillView> {
        return this.runtime.createSkill(createSkillInputOf(body));
    }

    /** POST /api/capabilities/reload：重新扫描 skills 根（新增/修改包目录后调用）。 */
    @Post('reload')
    async reload(): Promise<Record<string, unknown>> {
        return discoveryOf(await this.runtime.reloadSkills());
    }

    /** GET /api/capabilities/:id：manifest 全量 + 工具/记忆 schema/模板/校验器/事件。 */
    @Get(':id')
    async detail(@Param('id') id: string): Promise<SkillDetailView> {
        const detail = (await this.runtime.skills()).detail(id);
        if (detail === undefined) throw new ApiError(404, '技能不存在或未通过校验：' + id);
        return detail;
    }

    /** POST /api/capabilities/:id/mount：挂载（幂等）；未发现/未通过校验 → 404。 */
    @Post(':id/mount')
    async mount(@Param('id') id: string): Promise<SkillView> {
        const skills = await this.runtime.skills();
        if (skills.detail(id) === undefined)
            throw new ApiError(404, '技能不存在或未通过校验：' + id);
        return skills.mount(id);
    }

    /** POST /api/capabilities/:id/unmount：卸载（幂等）；立即从工具面移除。 */
    @Post(':id/unmount')
    async unmount(@Param('id') id: string): Promise<Record<string, unknown>> {
        const skills = await this.runtime.skills();
        const unmounted = await skills.unmount(id);
        return { ok: true, unmounted, mounted: skills.mounted() };
    }
}
