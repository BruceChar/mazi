import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/web：纯前端静态服务（与 apps/server 分离）。默认 5174；API 由前端指向 4317。 */
const PORT = Number.parseInt(process.env.MAZI_WEB_PORT ?? '5174', 10);
const PUBLIC_DIR = process.env.MAZI_WEB_PUBLIC
    ? resolve(process.env.MAZI_WEB_PUBLIC)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../public');

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const safe = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const file = join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
    }
    const ext = safe.slice(safe.lastIndexOf('.'));
    // 开发期 UI：禁止缓存，避免旧 app.js 残留导致“点了没反应”
    res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'no-store',
    });
    res.end(readFileSync(file));
});

server.listen(PORT, () => {
    process.stdout.write(
        `mazi web(UI) 已启动： http://127.0.0.1:${PORT} （静态: ${PUBLIC_DIR}）\n`,
    );
});
