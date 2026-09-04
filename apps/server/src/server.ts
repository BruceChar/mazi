import { createServer } from 'node:http';
import type { UserInteractionRecord } from '@mazi/core';
import type { RunOptions, RuntimeConfig } from '@mazi/harness-runtime';
import {
    configOverview,
    ensureMaziDirs,
    loadRuntimeConfig,
    HarnessRuntime as RT,
    toRuntimeConfig,
} from '@mazi/harness-runtime';
import { DefaultEventBus, newHarnessEvent } from '@mazi/observability';

/** apps/server：纯 API 后端（与前端分离）。REST + SSE + CORS；默认 SQLite；串行执行。 */
const PORT = Number.parseInt(
    process.env.MAZI_SERVER_PORT ?? process.env.MAZI_WEB_PORT ?? '4317',
    10,
);
const CORS_ORIGIN = process.env.MAZI_CORS_ORIGIN ?? '*';

let runtime: RT | undefined;
let busy = false;

function buildConfig(): RuntimeConfig {
    const paths = ensureMaziDirs();
    const file = loadRuntimeConfig(paths.home);
    return toRuntimeConfig(file, { consoleEnabled: false });
}
function rt(): RT {
    if (!runtime) runtime = new RT(buildConfig());
    return runtime;
}
function paths() {
    return ensureMaziDirs();
}

function cors(res: import('node:http').ServerResponse): void {
    res.setHeader('access-control-allow-origin', CORS_ORIGIN);
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
}
function json(res: import('node:http').ServerResponse, code: number, body: unknown): void {
    cors(res);
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

async function detail(sessionId: string) {
    const store = rt().store;
    const session = await store.loadSession(sessionId);
    if (!session) return undefined;
    const turns = [];
    for (const turn of session.turns) {
        turns.push({ ...turn, steps: await store.listSteps(turn.turnId) });
    }
    return { ...session, turns };
}

async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) {
        const e = new Error('已有会话在运行，请稍候') as Error & { status?: number };
        e.status = 409;
        throw e;
    }
    busy = true;
    try {
        return await fn();
    } finally {
        busy = false;
    }
}

function runOptions(body: Record<string, unknown>): RunOptions {
    return { userId: typeof body.userId === 'string' ? body.userId : undefined };
}

async function handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
): Promise<void> {
    const path = url.pathname;
    const isGet = req.method === 'GET';
    const isPost = req.method === 'POST';

    if (isGet && path === '/api/health') {
        return json(res, 200, {
            ok: true,
            busy,
            storage: { driver: 'sqlite', home: paths().home, db: paths().dbPath },
            providers: configOverview().providers,
        });
    }
    if (isGet && path === '/api/config') {
        const p = paths();
        return json(res, 200, {
            ...configOverview(),
            defaultConfigDir: p.home,
            storage: { driver: 'sqlite', db: p.dbPath, events: p.eventDir },
        });
    }
    if (isPost && path === '/api/run') {
        const body = await readBody(req);
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) return json(res, 400, { error: '缺少 input' });
        try {
            const result = await exclusive(() => rt().run(input, runOptions(body)));
            return json(res, 200, result);
        } catch (error) {
            const e = error as Error & { status?: number };
            return json(res, e.status ?? 500, { error: e.message });
        }
    }
    if (isPost && path === '/api/sessions') {
        const body = await readBody(req);
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) return json(res, 400, { error: '缺少 input' });
        const created = await rt().createSession(input, runOptions(body));
        return json(res, 200, { sessionId: created.sessionId, state: 'running' });
    }
    if (isPost && /^\/api\/sessions\/[^/]+\/run$/.test(path)) {
        const sessionId = path.split('/')[3];
        try {
            const result = await exclusive(() => rt().executeSession(sessionId));
            return json(res, 200, result);
        } catch (error) {
            const e = error as Error & { status?: number };
            return json(res, e.status ?? 500, { error: e.message });
        }
    }
    if (isGet && (path === '/api/sessions' || path === '/api/sessions/')) {
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
        const records = (await rt().store.listUserInteractionRecords({
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
    if (isGet && path.startsWith('/api/sessions/')) {
        const sessionId = path.split('/')[3];
        const d = await detail(sessionId);
        if (!d) return json(res, 404, { error: 'session not found' });
        return json(res, 200, d);
    }
    if (isGet && path.startsWith('/api/events/')) {
        const sessionId = path.slice('/api/events/'.length);
        const bus = new DefaultEventBus({ eventDir: paths().eventDir });
        const events = bus.replay(sessionId);
        if (url.searchParams.get('follow') !== '1') return json(res, 200, events);
        cors(res);
        res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        const push = (e: import('@mazi/core').HarnessEvent): void => {
            if (e.sessionId === sessionId)
                res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        bus.subscribe({}, { id: `sse-${sessionId}`, handle: push });
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => clearInterval(ping));
        return;
    }
    if (isPost && /^\/api\/sessions\/[^/]+\/feedback$/.test(path)) {
        const sessionId = path.split('/')[3];
        const body = await readBody(req);
        const type =
            body.type === 'text_feedback'
                ? 'text_feedback'
                : body.type === 'decision_change'
                  ? 'decision_change'
                  : 'output_rating';
        const feedback = {
            timestamp: Date.now(),
            type,
            content: typeof body.content === 'string' ? body.content : undefined,
            rating: typeof body.rating === 'number' ? body.rating : undefined,
        };
        const bus = new DefaultEventBus({ eventDir: paths().eventDir });
        bus.emit(
            newHarnessEvent({ type: 'user.feedback.captured', sessionId, payload: { feedback } }),
        );
        await bus.flush();
        return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
        if (req.method === 'OPTIONS') {
            cors(res);
            res.writeHead(204);
            return res.end();
        }
        await handle(req, res, url);
    } catch (error) {
        if (!res.headersSent) json(res, 500, { error: (error as Error).message });
        else res.end();
    }
});

server
    .listen(PORT, () => {
        process.stdout.write(
            `mazi server(API) 已启动： http://127.0.0.1:${PORT} （数据: ${paths().home}）\n`,
        );
    })
    .addListener('error', (err: Error & { code?: string }) => {
        if (err.code === 'EADDRINUSE') {
            process.stderr.write(`端口 ${PORT} 已被占用，请检查是否已有 mazi server 在运行\n`);
        }
    });
