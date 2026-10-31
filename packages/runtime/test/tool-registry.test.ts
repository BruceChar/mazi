import { describe, expect, it } from 'vitest';

import type { ToolConfig } from '../src/config.js';
import { RuntimeToolRegistry } from '../src/tool-gateway/registry.js';

function tool(name: string, sideEffects: ToolConfig['sideEffects'] = []): ToolConfig {
    return {
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        minPermission: 'read-only',
        sideEffects,
    };
}

describe('RuntimeToolRegistry', () => {
    it('registers, unregisters and versions immutable run snapshots', () => {
        const registry = new RuntimeToolRegistry([tool('a')]);
        const first = registry.snapshot();
        expect(first).toMatchObject({ version: 1, tools: [{ name: 'a' }] });

        expect(registry.register(tool('b', ['fs']))).toBe(2);
        const second = registry.snapshot();
        expect(second.tools.map((item) => item.name).sort()).toEqual(['a', 'b']);
        expect(second.digest).not.toBe(first.digest);
        expect(first.tools.map((item) => item.name)).toEqual(['a']);

        expect(registry.unregister('a')).toBe(true);
        expect(registry.unregister('a')).toBe(false);
        expect(registry.snapshot()).toMatchObject({ version: 3, tools: [{ name: 'b' }] });
    });

    it('rejects invalid names and missing side-effect declarations', () => {
        const registry = new RuntimeToolRegistry();
        expect(() => registry.register(tool('bad name'))).toThrow(/非法工具名/);
        expect(() =>
            registry.register({ ...tool('x'), sideEffects: undefined as never }),
        ).toThrow(/sideEffects/);
    });
});
