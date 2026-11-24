import { describe, expect, it } from 'vitest';

import { fingerprintKey, normalizeCommand } from '../src/authz/v5/fingerprint.js';
import { MemoryStore } from '../src/authz/v5/memory-store.js';

describe('normalizeCommand 归一化（§8）', () => {
    it('多余空白压缩为单空格', () => {
        expect(normalizeCommand('  pnpm   test  ')).toBe('pnpm test');
    });

    it('首尾引号等价：单双引号归一为同一指纹', () => {
        expect(normalizeCommand("'pnpm test'")).toBe(normalizeCommand('"pnpm test"'));
    });

    it('写法歧义不泛化：flag 顺序不同 → 不同指纹', () => {
        const a = fingerprintKey({ command: 'git log --oneline -5' });
        const b = fingerprintKey({ command: 'git log -5 --oneline' });
        expect(a).not.toBe(b);
    });
});

describe('fingerprintKey 目标绑定（§8）', () => {
    it('命令 + 目标绑定组合；目标不同 key 不同', () => {
        const a = fingerprintKey({ command: 'git push', targetBinding: 'origin/main' });
        const b = fingerprintKey({ command: 'git push', targetBinding: 'upstream/main' });
        expect(a).not.toBe(b);
    });

    it('内容哈希进入指纹：被绑对象改动即失效', () => {
        const a = fingerprintKey({ command: 'bash deploy.sh', contentHash: 'aaa' });
        const b = fingerprintKey({ command: 'bash deploy.sh', contentHash: 'bbb' });
        expect(a).not.toBe(b);
    });
});

describe('MemoryStore 作用域（§8/D14）', () => {
    it('session 作用域同会话命中，跨会话不命中', () => {
        const store = new MemoryStore();
        store.remember({ key: 'k1', scope: 'session', sessionId: 'c1', createdAt: 0, hazardLimited: false });
        expect(store.has('k1', { sessionId: 'c1' })).toBe(true);
        expect(store.has('k1', { sessionId: 'c2' })).toBe(false);
    });

    it('project 作用域全局命中', () => {
        const store = new MemoryStore();
        store.remember({ key: 'k2', scope: 'project', createdAt: 0, hazardLimited: false });
        expect(store.has('k2', {})).toBe(true);
    });

    it('once 不跨次命中', () => {
        const store = new MemoryStore();
        store.remember({ key: 'k3', scope: 'once', createdAt: 0, hazardLimited: true });
        expect(store.has('k3', {})).toBe(false);
    });

    it('hazard 受限条目禁止 project 作用域', () => {
        const store = new MemoryStore();
        expect(() =>
            store.remember({ key: 'k4', scope: 'project', createdAt: 0, hazardLimited: true }),
        ).toThrow();
    });

    it('内容哈希不匹配 → 不命中（文件改动即失效）', () => {
        const store = new MemoryStore();
        store.remember({
            key: 'k5',
            scope: 'session',
            sessionId: 'c1',
            contentHash: 'aaa',
            createdAt: 0,
            hazardLimited: false,
        });
        expect(store.has('k5', { sessionId: 'c1', contentHash: 'aaa' })).toBe(true);
        expect(store.has('k5', { sessionId: 'c1', contentHash: 'bbb' })).toBe(false);
    });

    it('revoke 单条与清空', () => {
        const store = new MemoryStore();
        store.remember({ key: 'a', scope: 'project', createdAt: 0, hazardLimited: false });
        store.remember({ key: 'b', scope: 'project', createdAt: 0, hazardLimited: false });
        expect(store.revoke('a')).toBe(1);
        expect(store.has('a', {})).toBe(false);
        expect(store.revoke()).toBe(1);
    });
});
