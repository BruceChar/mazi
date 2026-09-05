import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/web 生产静态服务：托管 Vite 构建产物 dist/（npm run build 后）。
const PORT = Number.parseInt(process.env.MAZI_WEB_PORT ?? '5174', 10);
const ROOT = resolve(fileURLToPath(import.meta.url), '..');
const DIST = process.env.MAZI_WEB_DIST ? resolve(process.env.MAZI_WEB_DIST) : join(ROOT, 'dist');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file)) {
    // SPA 兜底：未知路径回退 index.html（前端路由占位）
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('not found'); return; }
    const idx = join(DIST, 'index.html');
    if (existsSync(idx)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(readFileSync(idx)); return; }
    res.writeHead(404); res.end('not found'); return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
}).listen(PORT, () => process.stdout.write('mazi web(vue) 已启动： http://127.0.0.1:' + PORT + '\n'));