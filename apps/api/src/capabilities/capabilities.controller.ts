import 'reflect-metadata';
import type { SkillDetailView, SkillRuntime, SkillView } from '@mazi/runtime';
import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** 发现面：根（scope + dir）+ 技能列表 + 装载错误 + 被覆盖来源。 */
async function discoveryOf(skills: SkillRuntime): Promise<Record<string, unknown>> {
    return {
        roots: skills.registry.roots,
        skills: skills.list(),
        errors: skills.errors(),
        shadowed: skills.shadowed(),
    };
}

/**
 * 技能（能力包）管理：**发现 + 挂载 / 卸载**（docs/能力包规范.md §10）。
 * 技能是用户资产（$MAZI_HOME/skills、<workspace>/skills），不进代码仓库；
 * 挂载状态持久化在 $MAZI_HOME/skills.json。
 */
@Controller('capabilities')
export class CapabilitiesController {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** GET /api/capabilities：列出 skills 根下的技能与挂载状态。 */
    @Get()
    async list(): Promise<Record<string, unknown>> {
        return discoveryOf(await this.runtime.skills());
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
