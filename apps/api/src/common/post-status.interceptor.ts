import {
    CallHandler,
    ExecutionContext,
    HttpStatus,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

/**
 * API 契约：POST 统一返回 200（对齐旧 node:http 实现，docs v0.2 §10.4）。
 * Nest 默认 POST 为 201，本拦截器在响应写出前把「未显式指定」的 201 改回 200，
 * 使 controller 无需在每个 POST 上重复写 @HttpCode(200)。
 * 显式写了 @HttpCode(...) 的接口通过元数据识别，不受影响。
 */
@Injectable()
export class PostStatus200Interceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const http = context.switchToHttp();
        const request = http.getRequest<{ method?: string }>();
        if (request.method !== 'POST') return next.handle();

        const hasExplicitCode =
            Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) !== undefined;
        if (hasExplicitCode) return next.handle();

        const response = http.getResponse<{ statusCode?: number }>();
        return next.handle().pipe(
            tap(() => {
                if (response.statusCode === HttpStatus.CREATED) {
                    response.statusCode = HttpStatus.OK;
                }
            }),
        );
    }
}
