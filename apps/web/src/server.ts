import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserInteractionRecord } from '@mazi/core';
import type { RuntimeConfig } from '@mazi/harness-runtime';
import {
    configOverview,
    ensureMaziDirs,
    HarnessRuntime,
    loadRuntimeConfig,
    toRuntimeConfig,
} from '@mazi/harness-runtime';
import { DefaultEventBus } from '@mazi/observability';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public');
const PORT = Number.parseInt(process.env.MAZI_WEB_PORT ?? '4317', 10);

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

let runtime: HarnessRuntime | undefined;
let busy = false;

function paths(): ReturnType<typeof ensureMaziDirs> {
    return ensureMaziDirs();
}

function ensureRuntime(): HarnessRuntime {
    if (!runtime) {
        const file = loadRuntimeConfig(paths().home);
        const config: RuntimeConfig = toRuntimeConfig(file, { consoleEnabled: false });
        runtime = new HarnessRuntime(config);
    }
    return runtime;
}

function sendJson(res: import('node:http').ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => {
            raw += chunk.toString('utf8');
        });
        req.on('end', () => {
            try {
                resolve(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {});
            } catch (error) {
                reject(error as Error);
            }
        });
        req.on('error', reject);
    });
}

function hasProviders(): boolean {
    return configOverview().providers.length > 0;
}

async function handleApi(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
): Promise<void> {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/config') {
        const p = paths();
        return sendJson(res, 200, {
            ...configOverview(),
            defaultConfigDir: p.home,
            storage: { db: p.dbPath, events: p.eventDir },
        });
    }
    if (req.method === 'POST' && path === '/api/run') {
        if (busy) {
            return sendJson(res, 409, { error: '已有任务在运行，请稍候' });
        }
        if (!hasProviders()) {
            return sendJson(res, 400, {
                error: '未配置 provider：请先运行 pnpm mazi config --config-dir ~/.mazi 生成配置',
            });
        }
        const body = await readBody(req);
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) {
            return sendJson(res, 400, { error: '缺少 input' });
        }
        busy = true;
        try {
            const rt = ensureRuntime();
            const result = await rt.run(input, {
                userId: typeof body.userId === 'string' ? body.userId : undefined,
            });
            return sendJson(res, 200, result);
        } catch (error) {
            return sendJson(res, 500, { error: (error as Error).message });
        } finally {
            busy = false;
        }
    }
    if (req.method === 'GET' && path.startsWith('/api/runs')) {
        const rt = ensureRuntime();
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10);
        const records = (await rt.store.listUserInteractionRecords({
            limit,
        })) as UserInteractionRecord[];
        return sendJson(
            res,
            200,
            records.map((r) => ({
                sessionId: r.sessionId,
                input: r.rawInput,
                outcome: r.outcome?.status,
                summary: r.outcome?.summary,
                updatedAt: r.updatedAt,
                tokens: r.metrics.totalTokens,
                costUsd: r.metrics.totalCostUsd,
            })),
        );
    }
    if (req.method === 'GET' && path.startsWith('/api/events/')) {
        const sessionId = path.slice('/api/events/'.length);
        const bus = new DefaultEventBus({ eventDir: paths().eventDir });
        const events = bus.replay(sessionId);
        return sendJson(
            res,
            200,
            events.map((e) => ({
                type: e.type,
                timestamp: e.timestamp,
                sessionId: e.sessionId,
                turnId: e.turnId,
                stepId: e.stepId,
                payload: e.payload,
            })),
        );
    }
    return sendJson(res, 404, { error: 'not found' });
}

function serveStatic(res: import('node:http').ServerResponse, pathname: string): void {
    const safe = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = join(PUBLIC_DIR, safe);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
    }
    const ext = safe.slice(safe.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) {
            await handleApi(req, res, url);
        } else {
            serveStatic(res, url.pathname);
        }
    } catch (error) {
        if (!res.headersSent) {
            sendJson(res, 500, { error: (error as Error).message });
        } else {
            res.end();
        }
    }
});

server.listen(PORT, () => {
    process.stdout.write(
        `mazi web 已启动： http://127.0.0.1:${PORT} （数据目录：${paths().home}）\n`,
    );
});
