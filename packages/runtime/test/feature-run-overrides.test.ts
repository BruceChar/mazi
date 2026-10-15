import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, LLMProvider, LLMRequest, StreamCompletionEvent } from '@mazi/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillCatalogEntry, SkillProvider } from '../src/capabilities/runtime.js';
import type { RuntimeConfig } from '../src/config.js';
import { HarnessRuntime } from '../src/harness/index.js';

function configIn(dir: string): RuntimeConfig {
    return {
        providers: [],
        tools: [],
        dbPath: ':memory:',
        eventDir: dir,
        goal: { permissionCeiling: 'read-only' },
        contextWindow: 64000,
    };
}

/** 记录每次 LLM 请求（用于断言系统提示与工具面），并回一个成功终答。 */
function recordingProvider(requests: LLMRequest[]): LLMProvider {
    return {
        id: 'default',
        name: 'default',
        defaultModel: 'default',
        models: [],
        async ask() {
            throw new Error('ask unused');
        },
        async *askStream(request: LLMRequest): AsyncIterable<StreamCompletionEvent> {
            requests.push(request);
            yield { type: 'start', model: request.model ?? 'default' };
            yield { type: 'text_delta', text: '完成' };
            yield { type: 'finish', finishReason: 'stop' };
        },
    };
}

function fakeSkills(entries: SkillCatalogEntry[], mounted: string[]): SkillProvider {
    return {
        mounted: () => mounted,
        catalog: () => entries,
        catalogFor: (ids) => entries.filter((entry) => ids.includes(entry.id)),
    };
}

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newRuntime(options: { provider: LLMProvider; dir: string }): HarnessRuntime {
    dirs.push(options.dir);
    return new HarnessRuntime(configIn(options.dir), {
        llmProviders: { default: options.provider },
    });
}

function collect(runtime: HarnessRuntime): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    runtime.eventBus.subscribe(
        { types: ['flag.evaluated', 'capability.activated', 'capability.deactivated'] },
        { id: 'test-collector', handle: (event) => void events.push(event) },
    );
    return events;
}

async function execute(
    runtime: HarnessRuntime,
    opts: Parameters<HarnessRuntime['createGoalSession']>[1],
): Promise<string> {
    const created = await runtime.createGoalSession('同一输入', opts);
    await runtime.executeGoalTree(created.rootGoalId);
    return created.rootGoalId;
}

function systemText(request: LLMRequest): string {
    return typeof request.system === 'string' ? request.system : JSON.stringify(request.system);
}

describe('运行级 Feature 覆盖（docs/AB测试设计.md §4）', () => {
    it('promptFragment 追加到系统提示；缺省不追加', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-feature-prompt-'));
        const requests: LLMRequest[] = [];
        const runtime = newRuntime({ provider: recordingProvider(requests), dir });
        await execute(runtime, { promptFragment: '先给结论，再给理由。' });
        expect(systemText(requests[0] as LLMRequest)).toContain('先给结论，再给理由。');

        const second: LLMRequest[] = [];
        const runtime2 = newRuntime({
            provider: recordingProvider(second),
            dir: mkdtempSync(join(tmpdir(), 'mazi-feature-none-')),
        });
        await execute(runtime2, {});
        expect(systemText(second[0] as LLMRequest)).not.toContain('先给结论');
    });

    it('skillIds 覆盖全局挂载：只注入指定技能，并按该集合发激活事件', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-feature-skill-'));
        const requests: LLMRequest[] = [];
        const runtime = newRuntime({ provider: recordingProvider(requests), dir });
        runtime.setSkillProvider(
            fakeSkills(
                [
                    { id: 'mounted-skill', name: '挂载技能', description: 'd1', path: '/s/m' },
                    { id: 'run-skill', name: '运行技能', description: 'd2', path: '/s/r' },
                ],
                ['mounted-skill'],
            ),
        );
        const events = collect(runtime);
        await execute(runtime, { skillIds: ['run-skill'] });

        const system = systemText(requests[0] as LLMRequest);
        expect(system).toContain('运行技能');
        expect(system).not.toContain('挂载技能');
        const activated = events
            .filter((event) => event.type === 'capability.activated')
            .map((event) => event.attributes['harness.skill_id']);
        expect(activated).toEqual(['run-skill']);
    });

    it('allowedTools 只收窄工具面：与配置白名单取交集', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-feature-tools-'));
        const requests: LLMRequest[] = [];
        const runtime = newRuntime({ provider: recordingProvider(requests), dir });
        await execute(runtime, {});
        const allNames = (requests[0]?.tools ?? []).map((tool) => tool.name);
        expect(allNames.length).toBeGreaterThan(1);
        expect(allNames).toContain('fs.read');

        const narrowed: LLMRequest[] = [];
        const runtime2 = newRuntime({
            provider: recordingProvider(narrowed),
            dir: mkdtempSync(join(tmpdir(), 'mazi-feature-tools2-')),
        });
        await execute(runtime2, { allowedTools: ['fs.read'] });
        expect((narrowed[0]?.tools ?? []).map((tool) => tool.name)).toEqual(['fs.read']);
    });

    it('allowedTools 无法放宽：给出配置外的工具名不产生任何效果', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-feature-tools3-'));
        const requests: LLMRequest[] = [];
        const runtime = newRuntime({ provider: recordingProvider(requests), dir });
        await execute(runtime, { allowedTools: ['made-up-tool'] });
        expect((requests[0]?.tools ?? []).map((tool) => tool.name)).toEqual([]);
    });

    it('flag.evaluated 携带开关值与开启列表；无开关时不发事件', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-feature-flag-'));
        const runtime = newRuntime({ provider: recordingProvider([]), dir });
        const events = collect(runtime);
        await execute(runtime, {
            flagOverrides: { alpha: true, beta: false },
            flagTrace: [
                { id: 'alpha', enabled: true, source: 'override' },
                { id: 'beta', enabled: false, source: 'default' },
            ],
        });
        const flags = events.filter((event) => event.type === 'flag.evaluated');
        expect(flags).toHaveLength(1);
        expect(flags[0]?.attributes['harness.flag_overrides']).toEqual({
            alpha: true,
            beta: false,
        });
        expect(flags[0]?.attributes['harness.feature_ids']).toEqual(['alpha']);
        expect(flags[0]?.payload).toEqual({
            values: { alpha: true, beta: false },
            trace: [
                { id: 'alpha', enabled: true, source: 'override' },
                { id: 'beta', enabled: false, source: 'default' },
            ],
        });

        const plain: HarnessEvent[] = [];
        const runtime2 = newRuntime({
            provider: recordingProvider([]),
            dir: mkdtempSync(join(tmpdir(), 'mazi-feature-flag2-')),
        });
        runtime2.eventBus.subscribe(
            { types: ['flag.evaluated'] },
            { id: 'plain', handle: (event) => void plain.push(event) },
        );
        await execute(runtime2, {});
        expect(plain).toEqual([]);
    });

    it('运行级覆盖不影响其他 run（无覆盖的 run 仍走全局挂载）', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'mazi-feature-isolation-'));
        const requests: LLMRequest[] = [];
        const runtime = newRuntime({ provider: recordingProvider(requests), dir });
        runtime.setSkillProvider(
            fakeSkills(
                [{ id: 'mounted-skill', name: '挂载技能', description: 'd1', path: '/s/m' }],
                ['mounted-skill'],
            ),
        );
        await execute(runtime, { skillIds: ['run-skill'] });
        await execute(runtime, {});
        expect(systemText(requests[0] as LLMRequest)).not.toContain('挂载技能');
        expect(systemText(requests[1] as LLMRequest)).toContain('挂载技能');
    });
});
