import type { Capacity, FlagSnapshot, PolicyVerdict, ToolSpec } from '@mazi/core';
import { describe, expect, it } from 'vitest';
import { PolicyEngineImpl } from './policy-engine.js';
import { validateSchema } from './schema-validator.js';

/** 最小 FlagSnapshot stub：policy 校验不消费 Flag，仅满足 Capacity 类型 */
function stubFlags(): FlagSnapshot {
    return {
        values: {},
        trace: [],
        isEnabled: () => false,
        getNumber: () => undefined,
        getString: () => undefined,
    };
}

function makeTool(partial: Partial<ToolSpec>): ToolSpec {
    return {
        name: 'example.tool',
        description: '测试工具',
        parameters: {},
        minPermission: 'read-only',
        irreversible: false,
        sideEffects: [],
        ...partial,
    };
}

function makeCapacity(partial: Partial<Capacity> = {}): Capacity {
    return {
        model: { providerId: 'provider-a', vendor: 'vendor-a', modelId: 'model-a' },
        tools: [],
        permission: 'autonomous',
        budget: {},
        sandbox: { enabled: true },
        flags: stubFlags(),
        ...partial,
    };
}

/** 从 reason '<code>: <detail>' 提取拒绝编码 */
function denyCode(verdict: PolicyVerdict): string | undefined {
    return verdict.reason?.split(':')[0];
}

describe('PolicyEngineImpl（MVP v1.0 §5.3 顺序，命中即拒）', () => {
    it('① 白名单：白名单外工具 → tool-not-whitelisted', async () => {
        const engine = new PolicyEngineImpl();
        const capacity = makeCapacity({ tools: [makeTool({ name: 'allowed.tool' })] });
        const verdict = await engine.checkToolCall(capacity, 'ghost.tool', {});
        expect(denyCode(verdict)).toBe('tool-not-whitelisted');
        expect(verdict.reason).toMatch(/^tool-not-whitelisted: /);
    });

    it('② 权限：capacity.permission 低于 minPermission → permission-denied；齐平放行', async () => {
        const engine = new PolicyEngineImpl();
        const tool = makeTool({ name: 'write.file', minPermission: 'approved' });
        const denied = await engine.checkToolCall(
            makeCapacity({ tools: [tool], permission: 'draft' }),
            'write.file',
            {},
        );
        expect(denyCode(denied)).toBe('permission-denied');
        const passed = await engine.checkToolCall(
            makeCapacity({ tools: [tool], permission: 'approved' }),
            'write.file',
            {},
        );
        expect(passed).toEqual({ pass: true });
    });

    it('③ schema：参数不符合 mini JSON-Schema → schema-violation；合规放行', async () => {
        const engine = new PolicyEngineImpl();
        const tool = makeTool({
            name: 'fs.write',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: { path: { type: 'string', minLength: 3 } },
            },
        });
        const denied = await engine.checkToolCall(makeCapacity({ tools: [tool] }), 'fs.write', {});
        expect(denyCode(denied)).toBe('schema-violation');
        const passed = await engine.checkToolCall(makeCapacity({ tools: [tool] }), 'fs.write', {
            path: '/tmp/x',
        });
        expect(passed).toEqual({ pass: true });
    });

    it('④ 不可逆：irreversible 工具（无审批门）→ irreversible-blocked', async () => {
        const engine = new PolicyEngineImpl();
        const capacity = makeCapacity({
            tools: [makeTool({ name: 'db.drop', irreversible: true })],
        });
        const verdict = await engine.checkToolCall(capacity, 'db.drop', {});
        expect(denyCode(verdict)).toBe('irreversible-blocked');
    });

    it('⑤ constraints：network rule=off 拒 net 工具；rule=on 放行；未知 rule 值拒', async () => {
        const offEngine = new PolicyEngineImpl({
            goalConstraints: [{ kind: 'network', rule: 'off', description: '断网' }],
        });
        const netTool = makeTool({ name: 'http.get', sideEffects: ['net'] });
        const offline = await offEngine.checkToolCall(
            makeCapacity({ tools: [netTool] }),
            'http.get',
            {},
        );
        expect(denyCode(offline)).toBe('constraint-denied');
        const fsTool = makeTool({ name: 'fs.read', sideEffects: ['fs'] });
        expect(
            await offEngine.checkToolCall(makeCapacity({ tools: [fsTool] }), 'fs.read', {}),
        ).toEqual({ pass: true });

        const onEngine = new PolicyEngineImpl({
            goalConstraints: [{ kind: 'network', rule: 'on' }],
        });
        expect(
            await onEngine.checkToolCall(makeCapacity({ tools: [netTool] }), 'http.get', {}),
        ).toEqual({ pass: true });

        const badRuleEngine = new PolicyEngineImpl({
            goalConstraints: [{ kind: 'network', rule: 'tunnel' }],
        });
        const badRule = await badRuleEngine.checkToolCall(
            makeCapacity({ tools: [netTool] }),
            'http.get',
            {},
        );
        expect(denyCode(badRule)).toBe('constraint-denied');
        expect(badRule.reason).toContain("rule='tunnel' 不受支持");
    });

    it('⑤ constraints：forbidden-resource 命中副作用域即拒；不相交放行；未知 scope 拒', async () => {
        const engine = new PolicyEngineImpl({
            goalConstraints: [{ kind: 'forbidden-resource', rule: 'fs, net' }],
        });
        const fsTool = makeTool({ name: 'fs.write', sideEffects: ['fs'] });
        const hit = await engine.checkToolCall(makeCapacity({ tools: [fsTool] }), 'fs.write', {});
        expect(denyCode(hit)).toBe('constraint-denied');
        expect(hit.reason).toContain('forbidden-resource');

        const procTool = makeTool({ name: 'proc.list', sideEffects: ['process'] });
        expect(
            await engine.checkToolCall(makeCapacity({ tools: [procTool] }), 'proc.list', {}),
        ).toEqual({ pass: true });

        const weirdScope = new PolicyEngineImpl({
            goalConstraints: [{ kind: 'forbidden-resource', rule: 'registry' }],
        });
        const verdict = await weirdScope.checkToolCall(
            makeCapacity({ tools: [makeTool({ name: 'x', sideEffects: ['process'] })] }),
            'x',
            {},
        );
        expect(denyCode(verdict)).toBe('constraint-denied');
        expect(verdict.reason).toContain("未知 scope 'registry'");
    });

    it('⑤ constraints：spend/data-boundary/compliance/custom/未知 kind 一律拒（unsupported-kind）', async () => {
        const kinds = ['spend', 'data-boundary', 'compliance', 'custom', 'teleport'];
        for (const kind of kinds) {
            const engine = new PolicyEngineImpl({
                goalConstraints: [{ kind, rule: 'x' } as never],
            });
            const capacity = makeCapacity({
                tools: [makeTool({ name: 'any.tool', sideEffects: ['fs'] })],
            });
            const verdict = await engine.checkToolCall(capacity, 'any.tool', {});
            expect(denyCode(verdict)).toBe('constraint-denied');
            expect(verdict.reason).toContain(`kind='${kind}' 不受支持`);
        }
    });

    it('⑥ 预算：累计 + 预估 > maxCostUsd → budget-exceeded；等于上限放行；回填累计生效', async () => {
        const engine = new PolicyEngineImpl({ accumulatedCostUsd: 4 });
        expect(engine.getAccumulatedCostUsd()).toBe(4);
        const capacity = makeCapacity({
            tools: [makeTool({ name: 'costly.tool' })],
            budget: { maxCostUsd: 5 },
        });
        expect(await engine.checkToolCall(capacity, 'costly.tool', {}, 0.5)).toEqual({
            pass: true,
        });
        engine.setAccumulatedCostUsd(6);
        expect(engine.getAccumulatedCostUsd()).toBe(6);
        const over = await engine.checkToolCall(capacity, 'costly.tool', {}, 0);
        expect(denyCode(over)).toBe('budget-exceeded');
        engine.setAccumulatedCostUsd(5);
        expect(await engine.checkToolCall(capacity, 'costly.tool', {}, 0)).toEqual({
            pass: true,
        });
        // maxCostUsd 未定义时不触发预算检查
        const noBudget = await engine.checkToolCall(
            makeCapacity({ budget: {}, tools: [makeTool({ name: 'costly.tool' })] }),
            'costly.tool',
            {},
            999,
        );
        expect(noBudget).toEqual({ pass: true });
    });

    it('全通过路径：白名单/权限/schema/不可逆/constraints/预算全部合规 → pass:true', async () => {
        const engine = new PolicyEngineImpl({
            goalConstraints: [{ kind: 'network', rule: 'on' }],
        });
        const capacity = makeCapacity({
            tools: [
                makeTool({
                    name: 'safe.tool',
                    minPermission: 'draft',
                    parameters: {
                        type: 'object',
                        required: ['q'],
                        properties: { q: { type: 'string' } },
                    },
                    sideEffects: ['fs'],
                }),
            ],
            permission: 'draft',
            budget: { maxCostUsd: 100 },
        });
        const verdict = await engine.checkToolCall(capacity, 'safe.tool', { q: 'ok' }, 1);
        expect(verdict).toEqual({ pass: true });
    });
});

describe('validateSchema（mini JSON-Schema 子集，MVP §8 F7）', () => {
    it('object：required 缺失 / 递归属性 / additionalProperties=false 额外键 → issue，路径正确', () => {
        const schema = {
            type: 'object',
            required: ['name', 'meta'],
            properties: {
                name: { type: 'string' },
                meta: {
                    type: 'object',
                    properties: { score: { type: 'number', minimum: 0 } },
                },
            },
            additionalProperties: false,
        };
        const issues = validateSchema(schema, { name: 42, meta: { score: -1 }, extra: 1 });
        expect(issues).toHaveLength(3);
        expect(issues).toEqual(
            expect.arrayContaining([
                { path: '$.meta.score', message: expect.stringContaining('小于 minimum 0') },
                { path: '$.extra', message: '额外属性不允许（additionalProperties=false）' },
                { path: '$.name', message: expect.stringContaining('期望 type') },
            ]),
        );
        expect(validateSchema(schema, { name: 'ok', meta: { score: 3 } })).toEqual([]);
    });

    it('array：items 递归校验元素；tuple 数组形式不在子集 → issue', () => {
        const schema = {
            type: 'array',
            items: {
                type: 'object',
                required: ['id'],
                properties: { id: { type: 'number' } },
            },
        };
        const issues = validateSchema(schema, [{ id: 1 }, { id: 'x' }, {}]);
        expect(issues).toHaveLength(2);
        expect(issues).toEqual(
            expect.arrayContaining([
                { path: '$[1].id', message: expect.stringContaining("期望 type='number'") },
                { path: '$[2]', message: expect.stringContaining("缺少必填属性 'id'") },
            ]),
        );
        expect(validateSchema(schema, [{ id: 1 }])).toEqual([]);
        expect(validateSchema({ type: 'array', items: [{ type: 'string' }] }, ['a'])).toEqual([
            { path: '$', message: expect.stringContaining('items 仅支持单一 schema 对象') },
        ]);
    });

    it('string：minLength/maxLength/pattern 边界；非法 pattern 不抛异常', () => {
        const schema = { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' };
        expect(validateSchema(schema, 'ab')).toEqual([]);
        expect(validateSchema(schema, 'a')[0].message).toContain('小于 minLength 2');
        expect(validateSchema(schema, 'abcde')[0].message).toContain('大于 maxLength 4');
        expect(validateSchema(schema, 'ab1')[0].message).toContain("不匹配 pattern '^[a-z]+$'");
        expect(validateSchema({ type: 'string', pattern: '[' }, 'x')[0].message).toContain(
            '不是合法正则',
        );
    });

    it('number/boolean：minimum/maximum 闭区间边界；类型不符 → issue', () => {
        const schema = { type: 'number', minimum: 1, maximum: 5 };
        expect(validateSchema(schema, 1)).toEqual([]);
        expect(validateSchema(schema, 5)).toEqual([]);
        expect(validateSchema(schema, 0.5)[0].message).toContain('小于 minimum 1');
        expect(validateSchema(schema, 5.01)[0].message).toContain('大于 maximum 5');
        expect(validateSchema({ type: 'boolean' }, true)).toEqual([]);
        expect(validateSchema({ type: 'boolean' }, 1)[0].message).toContain("期望 type='boolean'");
        expect(validateSchema({ type: 'number' }, '5')[0].message).toContain("期望 type='number'");
    });

    it('enum：任意层（根纯 enum / 嵌套属性 / 与 type 同层），对象深度比较', () => {
        expect(validateSchema({ enum: ['a', 'b'] }, 'a')).toEqual([]);
        expect(validateSchema({ enum: ['a', 'b'] }, 'c')[0].message).toContain('不在 enum');
        const nested = {
            type: 'object',
            properties: {
                mode: { type: 'string', enum: ['fast', 'safe'] },
                target: { enum: [{ host: 'a' }, { host: 'b' }] },
            },
        };
        expect(validateSchema(nested, { mode: 'safe', target: { host: 'a' } })).toEqual([]);
        expect(validateSchema(nested, { mode: 'quick', target: { host: 'a' } })[0]).toEqual({
            path: '$.mode',
            message: expect.stringContaining('不在 enum 允许集合内'),
        });
        expect(validateSchema(nested, { mode: 'safe', target: { host: 'c' } })[0].path).toBe(
            '$.target',
        );
        expect(validateSchema({ enum: 'a' }, 'a')[0].message).toContain('enum 必须是数组');
    });

    it('未知关键字 → issue（fail-closed），含嵌套属性层级', () => {
        expect(validateSchema({ type: 'string', format: 'email' }, 'a@b.com')[0]).toEqual({
            path: '$',
            message: expect.stringContaining("未知关键字 'format'"),
        });
        const nested = {
            type: 'object',
            properties: { contact: { type: 'string', oneOf: [{ minLength: 1 }] } },
        };
        expect(validateSchema(nested, { contact: 'x' })).toEqual([
            { path: '$.contact', message: expect.stringContaining("未知关键字 'oneOf'") },
        ]);
    });

    it('未知 type / 非法 type 值 / 缺 type 的复杂节点 → issue（fail-closed）', () => {
        expect(validateSchema({ type: 'integer', minimum: 1 }, 2)[0].message).toContain(
            '不支持的 type',
        );
        expect(validateSchema({ type: 'null' }, null)[0].message).toContain('不支持的 type');
        expect(validateSchema({ type: ['string'] }, 'x')[0].message).toContain('不支持的 type');
        expect(
            validateSchema(
                { properties: { a: { type: 'string' } }, additionalProperties: false },
                { a: 'x' },
            )[0].message,
        ).toContain('缺少受支持的 type');
    });

    it('任何非法 schema 输入都不抛异常，仅返回 issue', () => {
        for (const bad of [null, 42, 'string', ['array'], { type: 'string', minLength: 'x' }]) {
            expect(() => validateSchema(bad, 'v')).not.toThrow();
        }
        expect(validateSchema(null, {})[0].message).toContain('schema 节点必须是对象');
        expect(validateSchema(['x'], {})[0].message).toContain('schema 节点必须是对象');
        expect(validateSchema({ type: 'string', minLength: 'x' }, 'v')[0].message).toContain(
            'minLength 必须是数字',
        );
    });
});
