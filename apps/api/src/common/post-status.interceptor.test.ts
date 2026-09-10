import 'reflect-metadata';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { PostStatus200Interceptor } from './post-status.interceptor.js';

describe('PostStatus200Interceptor（POST 统一 200 契约）', () => {
    const interceptor = new PostStatus200Interceptor();

    function makeContext(method: string, explicitCode?: number): ExecutionContext {
        const response = { statusCode: 201 };
        const handler = (): void => undefined;
        if (explicitCode !== undefined) {
            Reflect.defineMetadata(HTTP_CODE_METADATA, explicitCode, handler);
        }
        return {
            getHandler: () => handler,
            switchToHttp: () => ({
                getRequest: () => ({ method }),
                getResponse: () => response,
            }),
        } as unknown as ExecutionContext;
    }

    function next(): CallHandler {
        return { handle: () => of({ ok: true }) };
    }

    it('POST 未显式指定状态码：默认 201 被改写为 200', async () => {
        const ctx = makeContext('POST');
        await firstValueFrom(interceptor.intercept(ctx, next()));
        expect(ctx.switchToHttp().getResponse<{ statusCode: number }>().statusCode).toBe(200);
    });

    it('显式 @HttpCode 的 POST 不被改写', async () => {
        const ctx = makeContext('POST', 204);
        await firstValueFrom(interceptor.intercept(ctx, next()));
        expect(ctx.switchToHttp().getResponse<{ statusCode: number }>().statusCode).toBe(201);
    });

    it('非 POST 请求不受影响', async () => {
        const ctx = makeContext('GET');
        await firstValueFrom(interceptor.intercept(ctx, next()));
        expect(ctx.switchToHttp().getResponse<{ statusCode: number }>().statusCode).toBe(201);
    });
});
