import 'reflect-metadata';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppHandle } from '../src/testing/test-app.js';

/** 播种一个可控的 SQLite 库：两张业务表 + 一张表上的索引。 */
function seedDatabase(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec(`
        CREATE TABLE alpha (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            payload_json TEXT
        );
        CREATE INDEX idx_alpha_name ON alpha(name);
        CREATE TABLE beta (
            seq INTEGER PRIMARY KEY,
            note TEXT
        );
    `);
    const insertAlpha = db.prepare('INSERT INTO alpha (id, name, payload_json) VALUES (?, ?, ?)');
    insertAlpha.run('a1', 'first row', JSON.stringify({ needle: 'haystack', n: 1 }));
    insertAlpha.run('a2', 'second row', JSON.stringify({ n: 2 }));
    insertAlpha.run('a3', 'NEEDLE upper', null);
    const insertBeta = db.prepare('INSERT INTO beta (seq, note) VALUES (?, ?)');
    insertBeta.run(1, 'plain beta');
    insertBeta.run(2, 'another needle here');
    db.close();
}

describe('Storage 看板接口（docs/web/存储面板设计.md）', () => {
    let h: TestAppHandle;

    beforeAll(async () => {
        h = await createTestApp();
        seedDatabase(join(h.home, 'mazi.db'));
    });

    afterAll(async () => {
        await h.close();
    });

    it('S1 GET /api/storage：文件大小 + 页统计 + 逐表行数/占用', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/storage' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.driver).toBe('sqlite');
        expect(body.path).toBe(join(h.home, 'mazi.db'));
        expect(body.exists).toBe(true);
        expect(body.fileBytes).toBeGreaterThan(0);
        expect(body.pageSize).toBeGreaterThan(0);
        expect(body.pageCount).toBeGreaterThan(0);
        expect(body.totals.tables).toBeGreaterThanOrEqual(2);
        expect(body.totals.rows).toBe(5);

        const alpha = body.tables.find((t: { name: string }) => t.name === 'alpha');
        expect(alpha).toBeTruthy();
        expect(alpha.rows).toBe(3);
        expect(alpha.columns.map((c: { name: string }) => c.name)).toEqual([
            'id',
            'name',
            'payload_json',
        ]);
        expect(alpha.indexes).toBeGreaterThanOrEqual(1);
        expect(alpha.bytes).toBeGreaterThan(0);
        expect(Array.isArray(body.tables)).toBe(true);
    });

    it('S2 GET /api/storage/tables/:name：分页返回列与行', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/storage/tables/alpha?limit=2&offset=0',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.table).toBe('alpha');
        expect(body.columns).toEqual(['id', 'name', 'payload_json']);
        expect(body.rows).toHaveLength(2);
        expect(body.total).toBe(3);
        expect(body.limit).toBe(2);
        expect(body.offset).toBe(0);
    });

    it('S3 表内过滤：字面匹配且大小写不敏感', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/storage/tables/alpha?q=needle',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.total).toBe(2);
        expect(
            body.rows.every((r: Record<string, unknown>) =>
                JSON.stringify(r).toLowerCase().includes('needle'),
            ),
        ).toBe(true);
    });

    it('S4 GET /api/storage/search：跨表命中按表分组', async () => {
        const res = await h.fastify.inject({
            method: 'GET',
            url: '/api/storage/search?q=needle',
        });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.query).toBe('needle');
        expect(body.total).toBeGreaterThanOrEqual(3);
        const names = body.tables.map((t: { table: string }) => t.table);
        expect(names).toContain('alpha');
        expect(names).toContain('beta');
        const alpha = body.tables.find((t: { table: string }) => t.table === 'alpha');
        expect(alpha.matches).toBe(2);
    });

    it('S5 非法/不存在的表名 → 404，且拒绝 SQLite 内部表', async () => {
        for (const name of ['missing_table', 'sqlite_master']) {
            const res = await h.fastify.inject({
                method: 'GET',
                url: `/api/storage/tables/${name}`,
            });
            expect(res.statusCode).toBe(404);
            expect(res.json().error).toBe('table not found');
        }
    });

    it('空查询返回空结果，不报错', async () => {
        const res = await h.fastify.inject({ method: 'GET', url: '/api/storage/search?q=' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ query: '', total: 0, tables: [] });
    });
});
