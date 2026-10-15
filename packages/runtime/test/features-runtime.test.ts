import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureRuntime } from '../src/features/runtime.js';
import { FileFeatureStore, MemoryFeatureStore } from '../src/features/store.js';
import {
    coerceFeatureDefinition,
    FeatureConflictError,
    FeatureValidationError,
} from '../src/features/validate.js';

const dirs: string[] = [];
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mazi-features-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeIn(dir: string): FeatureRuntime {
    return new FeatureRuntime({ store: new FileFeatureStore(join(dir, 'features.json')) });
}

describe('coerceFeatureDefinition', () => {
    it('丢弃缺字段 / 非法 id / 非对象的记录', () => {
        expect(coerceFeatureDefinition({ id: 'Bad', name: 'n', description: 'd' })).toBeUndefined();
        expect(coerceFeatureDefinition({ id: 'ok', name: 'n' })).toBeUndefined();
        expect(coerceFeatureDefinition('nope')).toBeUndefined();
        expect(coerceFeatureDefinition({ id: 'ok', name: 'n', description: 'd' })?.enabled).toBe(
            false,
        );
    });

    it('归一可选字段：去重排序、空数组视为未声明', () => {
        const feature = coerceFeatureDefinition({
            id: 'ok',
            name: ' n ',
            description: 'd',
            enabled: true,
            skills: ['b', 'a', 'a', '  '],
            allowedTools: [],
            skillMode: 'weird',
        });
        expect(feature?.name).toBe('n');
        expect(feature?.skills).toEqual(['a', 'b']);
        expect(feature?.allowedTools).toBeUndefined();
        expect(feature?.skillMode).toBeUndefined();
    });
});

describe('FileFeatureStore', () => {
    it('roundtrip：写入后可读回', async () => {
        const dir = tempDir();
        const store = new FileFeatureStore(join(dir, 'features.json'));
        await store.write([{ id: 'a', name: 'A', description: 'd', enabled: true }]);
        expect((await store.read()).map((f) => f.id)).toEqual(['a']);
    });

    it('文件损坏 → 空集合 + 告警，不抛错', async () => {
        const dir = tempDir();
        const warnings: string[] = [];
        const file = join(dir, 'features.json');
        writeFileSync(file, '{ not json', 'utf8');
        const store = new FileFeatureStore(file, (message) => warnings.push(message));
        expect(await store.read()).toEqual([]);
        expect(warnings[0]).toContain('解析失败');
    });

    it('坏记录被跳过，好记录保留', async () => {
        const dir = tempDir();
        const warnings: string[] = [];
        const file = join(dir, 'features.json');
        writeFileSync(
            file,
            JSON.stringify({ features: [{ id: 'BAD' }, { id: 'good', name: 'G', description: 'd' }] }),
            'utf8',
        );
        const store = new FileFeatureStore(file, (message) => warnings.push(message));
        expect((await store.read()).map((f) => f.id)).toEqual(['good']);
        expect(warnings.length).toBe(1);
    });
});

describe('FeatureRuntime CRUD 与持久化', () => {
    it('create → 落盘 → 新实例可读回（用户资产跨重启保持）', async () => {
        const dir = tempDir();
        const runtime = runtimeIn(dir);
        await runtime.create({
            id: 'concise-answers',
            name: '简洁回答',
            description: '回答先给结论',
            enabled: true,
            promptFragment: '先给结论，再给理由。',
        });
        const reloaded = runtimeIn(dir);
        await reloaded.init();
        expect(reloaded.get('concise-answers')?.promptFragment).toBe('先给结论，再给理由。');
        expect(reloaded.summary()).toMatchObject({ total: 1, enabled: 1 });
    });

    it('重复 id → FeatureConflictError；非法 id → FeatureValidationError', async () => {
        const runtime = new FeatureRuntime({ store: new MemoryFeatureStore() });
        await runtime.create({ id: 'dup', name: 'D', description: 'd' });
        await expect(runtime.create({ id: 'dup', name: 'D', description: 'd' })).rejects.toBeInstanceOf(
            FeatureConflictError,
        );
        await expect(
            runtime.create({ id: 'Not-Kebab', name: 'D', description: 'd' }),
        ).rejects.toBeInstanceOf(FeatureValidationError);
    });

    it('update 局部修改开关并保留 createdAt；null 清空可选字段', async () => {
        const runtime = new FeatureRuntime({ store: new MemoryFeatureStore(), now: () => 1000 });
        await runtime.create({
            id: 'f',
            name: 'F',
            description: 'd',
            promptFragment: '片段',
        });
        const updated = await runtime.update('f', { enabled: true, promptFragment: null });
        expect(updated?.enabled).toBe(true);
        expect(updated?.promptFragment).toBeUndefined();
        expect(updated?.createdAt).toBe(1000);
        expect(await runtime.update('missing', { enabled: true })).toBeUndefined();
    });

    it('remove 幂等；删除后落盘不再包含', async () => {
        const dir = tempDir();
        const runtime = runtimeIn(dir);
        await runtime.create({ id: 'gone', name: 'G', description: 'd' });
        expect(await runtime.remove('gone')).toBe(true);
        expect(await runtime.remove('gone')).toBe(false);
        const raw = JSON.parse(readFileSync(join(dir, 'features.json'), 'utf8')) as {
            features: unknown[];
        };
        expect(raw.features).toEqual([]);
    });

    it('list 按 id 升序；resolve 应用运行期 override', async () => {
        const runtime = new FeatureRuntime({ store: new MemoryFeatureStore() });
        await runtime.create({ id: 'zeta', name: 'Z', description: 'd', enabled: false });
        await runtime.create({ id: 'alpha', name: 'A', description: 'd', enabled: true });
        expect(runtime.list().map((f) => f.id)).toEqual(['alpha', 'zeta']);
        const resolved = runtime.resolve({ zeta: true, alpha: false });
        expect(resolved.enabledIds).toEqual(['zeta']);
        expect(resolved.trace).toEqual([
            { id: 'alpha', enabled: false, source: 'override' },
            { id: 'zeta', enabled: true, source: 'override' },
        ]);
    });
});
