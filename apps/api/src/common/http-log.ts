import type { FastifyInstance } from 'fastify';
import Logger from './log.js';

/**
 * 不计入访问日志的轮询路径：webui 每 5s 健康检查一次，若写日志会持续刷屏。
 * 命中路径只跳过日志输出，不影响请求处理。
 */
export const LOG_FILTER_PATHS = new Set(['/api/health']);

export interface HttpLogOptions {
    logger?: Logger;
}

/** 注册 HTTP 访问日志钩子（方法/路径/状态码/耗时）；LOG_FILTER_PATHS 内路径跳过记录 */
export function registerHttpLogging(fastify: FastifyInstance, options: HttpLogOptions = {}): void {
    const logger = options.logger ?? new Logger('api');
    const withStart = (req: object & { start?: number }): number => {
        req.start = Date.now();
        return req.start;
    };
    fastify.addHook('onRequest', (req, _reply, done) => {
        withStart(req as object & { start?: number });
        done();
    });
    fastify.addHook('onResponse', (req, reply, done) => {
        const started = (req as { start?: number }).start ?? Date.now();
        const ms = Date.now() - started;
        const path = String(req.url).split('?')[0];
        if (!LOG_FILTER_PATHS.has(path)) {
            logger.log(`[api] ${reply.statusCode} ${req.method} ${req.url} ${ms}ms`);
        }
        done();
    });
}
