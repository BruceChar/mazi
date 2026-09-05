import 'reflect-metadata';
import type { UserInteractionRecord } from '@mazi/core';
import type { CreateSessionOptions, RunResult, SessionGoalOverrides } from '@mazi/harness-runtime';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error.js';
import { ApiRuntimeService } from '../common/runtime.service.js';

/** 会话列表投影行（GET /api/sessions 响应元素，契约对齐旧实现） */
export interface SessionListItem {
    sessionId: string;
    userId?: string;
    title: string;
    input: string;
    outcome?: string;
    summary?: string;
    updatedAt?: number;
    createdAt: number;
    tokens?: number;
    costUsd?: number;
    turns?: number;
}

/** 会话详情：session + turns（每 turn 挂 steps 树，webui timeline 使用） */
export type SessionDetail = Record<string, unknown>;

/**
 * SessionsService：会话创建/执行/查询投影（docs v0.2 §10.4 契约矩阵）。
 * 领域与存储复用 @mazi/harness-runtime / @mazi/memory，本层仅做编排与投影映射。
 */
@Injectable()
export class SessionsService {
    constructor(private readonly runtime: ApiRuntimeService) {}

    /** POST /api/sessions：创建会话（不执行）；body.input 必填，body.goal 透传（运行时语义同旧实现） */
    async createSession(
        body: Record<string, unknown>,
    ): Promise<{ sessionId: string; state: string }> {
        const input = typeof body.input === 'string' ? body.input.trim() : '';
        if (!input) {
            throw new ApiError(400, '缺少 input');
        }
        const options: CreateSessionOptions = {
            userId: typeof body.userId === 'string' ? body.userId : undefined,
            goal:
                typeof body.goal === 'object' && body.goal
                    ? (body.goal as SessionGoalOverrides)
                    : undefined,
        };
        const created = await this.runtime.harness().createSession(input, options);
        return { sessionId: created.sessionId, state: 'running' };
    }

    /** POST /api/run 与 POST /api/sessions/:id/run：进程内串行执行（busy → 409） */
    async run(input: string, userId?: string): Promise<RunResult> {
        return this.runtime.runExclusive(() => this.runtime.harness().run(input, { userId }));
    }

    async executeSession(sessionId: string): Promise<RunResult> {
        return this.runtime.runExclusive(() => this.runtime.harness().executeSession(sessionId));
    }

    /** GET /api/sessions：最近交互记录投影（分页参数兼容：?limit=） */
    async listSessions(limit: number): Promise<SessionListItem[]> {
        const records = (await this.runtime
            .harness()
            .store.listUserInteractionRecords({ limit })) as UserInteractionRecord[];
        return records.map((r) => ({
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
        }));
    }

    /** GET /api/sessions/:id（含 /:id/timeline）：session + turns.steps 详情树 */
    async sessionDetail(sessionId: string): Promise<SessionDetail> {
        const store = this.runtime.harness().store;
        const session = await store.loadSession(sessionId);
        if (!session) {
            throw new ApiError(404, 'session not found');
        }
        const turns = [];
        for (const turn of session.turns) {
            turns.push({ ...turn, steps: await store.listSteps(turn.turnId) });
        }
        return { ...session, turns };
    }
}
