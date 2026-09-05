import 'reflect-metadata';
import {
    type ArgumentsHost,
    Catch,
    type ExceptionFilter,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/** 带 HTTP 状态码的业务错误：抛出后经 {@link ApiExceptionsFilter} 输出为 { error: message } */
export class ApiError extends Error {
    constructor(
        readonly statusCode: number,
        message: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

/**
 * 全局异常过滤器：错误体与旧 node:http 实现逐字对齐（docs/后端与存储设计.md v0.2 D-HTTP-2）。
 * ApiError → 自身状态码与消息；未匹配路由 404 → 'not found'；其余 → 500 + 异常消息。
 */
@Catch()
export class ApiExceptionsFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<FastifyReply>();
        const body = this.toErrorBody(exception);
        if (!response.sent) {
            void response.status(body.statusCode).send({ error: body.message });
        }
    }

    private toErrorBody(exception: unknown): { statusCode: number; message: string } {
        if (exception instanceof ApiError) {
            return { statusCode: exception.statusCode, message: exception.message };
        }
        if (exception instanceof HttpException) {
            const statusCode = exception.getStatus();
            const message = statusCode === HttpStatus.NOT_FOUND ? 'not found' : exception.message;
            return { statusCode, message };
        }
        const message = exception instanceof Error ? exception.message : String(exception);
        return { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message };
    }
}
