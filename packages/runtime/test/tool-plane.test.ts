import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authz, type Goal } from '@mazi/core';
import { AgentRoleRegistry } from '../src/agent/roles.js';
import { MemoryBlackboardStore, ProjectBlackboardService } from '../src/blackboard/index.js';
import type { ToolCallResult } from '../src/config.js';
import { DefaultEventBus } from '../src/events/event-bus.js';
import { DefaultFaultPipeline } from '../src/faults/pipeline.js';
import { HookRunner } from '../src/hooks/runner.js';
import type { RuntimeConfig } from '../src/config.js';
import { RuntimeToolRegistry } from '../src/tool-gateway/registry.js';
import { ToolPlane, type ToolPlaneDeps } from '../src/harness/tool-plane.js';
import { WikiService } from '../src/wiki/index.js';

const noopResult: ToolCallResult = { ok: true, content: '' };

function buildPlane(): { plane: ToolPlane; calls: string[] } {
    const calls: string[] = [];
    const config = {
        providers: [],
        tools: [],
    } as unknown as RuntimeConfig;
    const deps: ToolPlaneDeps = {
        config,
        toolRegistry: new RuntimeToolRegistry([]),
        workspaceRoot: mkdtempSync(join(tmpdir(), 'mazi-tool-plane-')),
        hooks: new HookRunner({ emit: () => {} }),
        faults: new DefaultFaultPipeline(),
        bus: new DefaultEventBus({ eventDir: mkdtempSync(join(tmpdir(), 'mazi-events-')) }),
        approvalStore: new authz.InMemoryApprovalStore(),
        commandPolicy: {},
        wiki: new WikiService({
            home: mkdtempSync(join(tmpdir(), 'mazi-home-')),
            workspace: mkdtempSync(join(tmpdir(), 'mazi-ws-')),
        }),
        blackboard: new ProjectBlackboardService(new MemoryBlackboardStore()),
        delegationRoles: new AgentRoleRegistry(),
        getSkillProvider: () => undefined,
        getApprovalSeam: () => undefined,
        execute: async (tool) => {
            calls.push(tool.name);
            return noopResult;
        },
        delegate: async () => {
            calls.push('delegate');
            return noopResult;
        },
    };
    return { plane: new ToolPlane(deps), calls };
}

const parentGoal = { statement: 'root', permissionCeiling: 'read-only' } as unknown as Goal;

describe('ToolPlane', () => {
    it('深度未超限时把 delegate 暴露给模型，达到上限后收回', () => {
        const { plane } = buildPlane();
        const atRoot = plane.config({ rootGoalId: 'r', goalId: 'g', level: 'read-only', parentGoal });
        expect(atRoot.allowedTools).toContain('delegate');

        const tooDeep = plane.config({
            rootGoalId: 'r',
            goalId: 'g',
            level: 'read-only',
            parentGoal,
            delegationDepth: 2,
        });
        expect(tooDeep.allowedTools).not.toContain('delegate');
    });

    it('有项目与工作区时挂上 blackboard，并按其权限生成 planTool', () => {
        const { plane } = buildPlane();
        const exec = plane.config({
            rootGoalId: 'r',
            goalId: 'g',
            level: 'workspace-write',
            projectId: 'p1',
            parentGoal,
        });
        expect(exec.allowedTools).toContain('blackboard.read');
        expect(exec.planTools.find((tool) => tool.name === 'delegate')?.minPermission).toBe(
            'read-only',
        );
    });

    it('freshContext 时不暴露项目黑板工具', () => {
        const { plane } = buildPlane();
        const exec = plane.config({
            rootGoalId: 'r',
            goalId: 'g',
            level: 'read-only',
            projectId: 'p1',
            freshContext: true,
        });
        expect(exec.allowedTools).not.toContain('blackboard.read');
    });

    it('运行级白名单只收窄，不收窄到白名单之外', () => {
        const { plane } = buildPlane();
        const exec = plane.config({
            rootGoalId: 'r',
            goalId: 'g',
            level: 'read-only',
            parentGoal,
            allowedToolsOverride: ['delegate'],
        });
        expect(exec.allowedTools).toEqual(['delegate']);
        expect(exec.tools.map((tool) => tool.name)).toEqual(['delegate']);
    });

    it('每次装配都固定一份注册表快照版本与摘要', () => {
        const { plane } = buildPlane();
        const first = plane.config({ rootGoalId: 'r', goalId: 'g', level: 'read-only' });
        const second = plane.config({ rootGoalId: 'r', goalId: 'g', level: 'read-only' });
        expect(first.toolsetVersion).toBe(second.toolsetVersion);
        expect(first.toolsetDigest).toBe(second.toolsetDigest);
    });
});
