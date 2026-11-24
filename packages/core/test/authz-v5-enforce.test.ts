import { describe, expect, it } from 'vitest';

import { allowsMemory, allowsRoutine, type EnforceLevel } from '../src/authz/v5/enforce-level.js';

describe('强制层放行域矩阵（§11/D17）', () => {
    it('none（纯 auth）：执行/出站限 once，不进指纹记忆与例行', () => {
        expect(allowsMemory('none', 'exec')).toBe(false);
        expect(allowsMemory('none', 'egress')).toBe(false);
        expect(allowsRoutine('none', 'exec')).toBe(false);
        expect(allowsRoutine('none', 'egress')).toBe(false);
    });

    it('unix 基线：OS 后盾只闭合 external/凭证，执行/出站仍受限', () => {
        expect(allowsMemory('unix', 'exec')).toBe(false);
        expect(allowsMemory('unix', 'egress')).toBe(false);
        expect(allowsRoutine('unix', 'exec')).toBe(false);
        expect(allowsRoutine('unix', 'egress')).toBe(false);
    });

    it('network：执行/出站可 session 记忆、可进例行（出站有机械边界）', () => {
        expect(allowsMemory('network', 'exec')).toBe(true);
        expect(allowsMemory('network', 'egress')).toBe(true);
        expect(allowsRoutine('network', 'exec')).toBe(true);
        expect(allowsRoutine('network', 'egress')).toBe(true);
    });

    it('full 完整沙箱：全量放行域', () => {
        expect(allowsMemory('full', 'exec')).toBe(true);
        expect(allowsMemory('full', 'egress')).toBe(true);
        expect(allowsRoutine('full', 'exec')).toBe(true);
        expect(allowsRoutine('full', 'egress')).toBe(true);
    });

    it('类型覆盖四个成熟度级别', () => {
        const levels: EnforceLevel[] = ['none', 'unix', 'network', 'full'];
        expect(levels).toHaveLength(4);
    });
});
