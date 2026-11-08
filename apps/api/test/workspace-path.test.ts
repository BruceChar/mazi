import { describe, expect, it } from 'vitest';
import {
    looksLikeWorkspacePath,
    normalizeWorkspacePath,
    sameWorkspacePath,
} from '../src/common/workspace-path.js';

describe('workspace-path 归一化助手', () => {
    it('去掉结尾斜杠并解析 . / ..（纯字符串，不触盘）', () => {
        expect(normalizeWorkspacePath('/Users/bruce/nodejs/whoami/')).toBe(
            '/Users/bruce/nodejs/whoami',
        );
        expect(normalizeWorkspacePath('/a/b/./c/../d/')).toBe('/a/b/d');
        expect(normalizeWorkspacePath('/a//b/')).toBe('/a/b');
        expect(normalizeWorkspacePath('/')).toBe('/');
    });

    it('空/纯空白 → 空字符串（不静默回退到进程 cwd）', () => {
        expect(normalizeWorkspacePath('')).toBe('');
        expect(normalizeWorkspacePath('   ')).toBe('');
    });

    it('保持大小写与中文路径原样', () => {
        expect(normalizeWorkspacePath('/Users/bruce/Documents/boss简历投递/')).toBe(
            '/Users/bruce/Documents/boss简历投递',
        );
    });

    it('同一目录的不同写法判定相等', () => {
        expect(sameWorkspacePath('/x/', '/x')).toBe(true);
        expect(sameWorkspacePath('/x/./y/../', '/x')).toBe(true);
        expect(sameWorkspacePath('/x', '/y')).toBe(false);
    });

    it('looksLikeWorkspacePath 只认绝对路径形态', () => {
        expect(looksLikeWorkspacePath('/Users/bruce/nodejs/whoami/')).toBe(true);
        expect(looksLikeWorkspacePath('C:\\Users\\bruce\\')).toBe(true);
        expect(looksLikeWorkspacePath('b1bfc5a1be89bbf5')).toBe(false);
        expect(looksLikeWorkspacePath('project-a')).toBe(false);
        expect(looksLikeWorkspacePath('')).toBe(false);
    });
});
