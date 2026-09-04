import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UserInteractionRecord } from '@mazi/core';
import type { RuntimeConfig } from '@mazi/harness-runtime';
import {
    configOverview,
    ensureMaziDirs,
    loadRuntimeConfig,
    toRuntimeConfig,
} from '@mazi/harness-runtime';
import { DefaultEventBus, newHarnessEvent } from '@mazi/observability';
import { RuntimeHost } from './runtime-host.js';

// 前端静态目录：优先 env MAZI_WEB_PUBLIC，缺省 ../web/public（apps/server/dist 相对位置）
const PUBLIC_DIR = process.env.MAZI_WEB_PUBLIC
    ? resolve(process.env.MAZI_WEB_PUBLIC)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../web/public');
const PORT = Number.parseInt(process.env.MAZI_WEB_PORT ?? '4317', 10);

const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

function buildConfig(): RuntimeConfig {
    const paths = ensureMaziDirs();
    const file = loadRuntimeConfig(paths.home);
    return toRuntimeConfig(file, { consoleEnabled: false });
}

const host = new RuntimeHost(buildConfig);

function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
        req.on('end', () => {
            try {
                resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
            } catch (error) {
                reject(error as Error);
            }
        });
        req.on('error', reject);
    });
}

async function getSessionDetail(sessionId: string) {
    const rt = host.getRuntime();
    const session = await rt.store.loadSession(sessionId);
    if (!session) return undefined;
    const turns = [];
    for (const turn of session.turns) {
        const steps = await rt.store.listSteps(turn.turnId);
        turns.push({ ...turn, steps });
    }
    return { ...session, turns };
}

async function handleApi(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
): Promise<void> {
    const path = url.pathname;
    const rt = host.getRuntime();
    if (req.method === 'GET' && path === '/api/health') {
        const overview = configOverview();
        return json(res, 200, {
            ok: true,
            storage: { driver: 'sqlite', home: ensureMaziDirs().home, db: ensureMaziDirs().dbPath },
            providers: overview.providers,
            busy: host.isBusy(),
        });
    }
    if (req.method === 'GET' && path === '/api/config') {
        const p = ensureMaziDirs();
        return json(res, 200, {
            ...configOverview(),
            defaultConfigDir: p.home,
            storage: { driver: 'sqlite', db: p.dbPath, events: p.eventDir },
        });
    }
    if (req.method === 'POST' && path === '/api/run') {
        const body = await readBody(req);
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) return json(res, 400, { error: '缺少 input' });
        try {
            const result = await host.run(
                input,
                typeof body.userId === 'string' ? body.userId : undefined,
            );
            return json(res, 200, result);
        } catch (error) {
            const e = error as Error & { status?: number };
            return json(res, e.status ?? 500, { error: e.message });
        }
    }
    if (req.method === 'GET' && path.startsWith('/api/sessions')) {
        const rest = path.slice('/api/sessions'.length);
        if (rest === '' || rest === '/') {
            // MVP 会话列表来自 user_interactions（最近运行）
            const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
            const records = (await rt.store.listUserInteractionRecords({
                limit,
            })) as UserInteractionRecord[];
            return json(
                res,
                200,
                records.map((r) => ({
                    sessionId: r.sessionId,
                    userId: r.userId,
                    title: r.rawInput.slice(0, 80),
                    input: r.rawInput,
                    outcome: r.outcome?.status,
                    summary: r.outcome?.summary,
                    updatedAt: r.updatedAt,
                    createdAt: r.inputTimestamp,
                    tokens: r.metrics.totalTokens,
                    costUsd: r.metrics.totalCostUsd,
                    turns: r.metrics.turnCount,
                })),
            );
        }
        const sessionId = rest.replace(/^\//, '').split('?')[0];
        if (req.method === 'GET' && sessionId) {
            if (path.endsWith('/timeline')) {
                const id = sessionId.replace(/\/timeline$/, '');
                const detail = await getSessionDetail(id);
                return detail
                    ? json(res, 200, detail)
                    : json(res, 404, { error: 'session not found' });
            }
            const detail = await getSessionDetail(sessionId);
            return detail ? json(res, 200, detail) : json(res, 404, { error: 'session not found' });
        }
        return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && path.startsWith('/api/events/')) {
        const sessionId = path.slice('/api/events/'.length);
        const follow = url.searchParams.get('follow') === '1';
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '5000', 10);
        const bus = new DefaultEventBus({ eventDir: ensureMaziDirs().eventDir });
        const events = bus.replay(sessionId).slice(-limit);
        if (!follow) {
            return json(res, 200, events);
        }
        // SSE：先推已落盘事件，再订阅总线增量直到连接关闭
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        for (const e of events) {
            res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        }
        const push = (e: import('@mazi/core').HarnessEvent): void => {
            if (e.sessionId === sessionId) {
                res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
            }
        };
        bus.subscribe({}, { id: `sse-${sessionId}`, handle: push });
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
            clearInterval(ping);
            void bus;
        });
        return;
    }
    if (req.method === 'POST' && path.startsWith('/api/sessions/') && path.endsWith('/feedback')) {
        const sessionId = path.split('/')[3];
        const body = await readBody(req);
        const feedback = {
            timestamp: Date.now(),
            type:
                (body.type as string) === 'text_feedback'
                    ? 'text_feedback'
                    : (body.type as string) === 'decision_change'
                      ? 'decision_change'
                      : 'output_rating',
            content: typeof body.content === 'string' ? body.content : undefined,
            rating: typeof body.rating === 'number' ? body.rating : undefined,
            target:
                typeof body.target === 'object' && body.target
                    ? (body.target as object)
                    : undefined,
        };
        const bus = new DefaultEventBus({ eventDir: ensureMaziDirs().eventDir });
        bus.emit(
            newHarnessEvent({
                type: 'user.feedback.captured',
                sessionId,
                payload: { feedback },
            }),
        );
        await bus.flush();
        return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
}

function serveStatic(res: import('node:http').ServerResponse, pathname: string): void {
    const safe = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
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
            json(res, 500, { error: (error as Error).message });
        } else {
            res.end();
        }
    }
});

server.listen(PORT, () => {
    process.stdout.write(
        `mazi server 已启动： http://127.0.0.1:${PORT} （前端: ${PUBLIC_DIR}；数据: ${ensureMaziDirs().home}）\n`,
    );
});
