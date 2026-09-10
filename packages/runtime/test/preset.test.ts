import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_PRESET } from '../src/tools/preset.js';

describe('BUILTIN_TOOL_PRESET（CLI 工具预设）', () => {
    it('覆盖结构/搜索/查看类命令且名称唯一', () => {
        const names = BUILTIN_TOOL_PRESET.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual(
            expect.arrayContaining(['fs.read', 'rg', 'fd', 'bat', 'eza', 'difft', 'sd']),
        );
    });

    it('CLI 工具带 command 规格（bin + argv 模板），不可逆写入工具标记', () => {
        const rg = BUILTIN_TOOL_PRESET.find((t) => t.name === 'rg');
        expect(rg?.command?.bin).toBe('rg');
        expect(rg?.command?.args.join(' ')).toContain('{pattern}');
        const sd = BUILTIN_TOOL_PRESET.find((t) => t.name === 'sd');
        expect(sd?.command?.bin).toBe('sd');
        expect(sd?.irreversible).toBe(true);
    });
});
