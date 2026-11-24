/**
 * V5 运行时上下文组装（R2）：把指纹记忆、红线、routine 模型、纠正日志、
 * 留痕存储接成 core `authz.DecisionContext`，供 `authz.decide` 七行链使用。
 * 旧 v3 网关装配保持不动；本类是 v5 网关切换的装配入口。
 */

import { authz } from '@mazi/core';

export interface V5ContextOptions {
    sessionId?: string;
    /** 本轮无污点入上下文（round_clean）；直通前提。 */
    roundClean?: boolean;
}

export class V5RuntimeContext {
    readonly memory = new authz.MemoryStore();
    readonly blocked = new authz.BlockedStore();
    readonly routine = new authz.RoutineModel();
    readonly correction = new authz.CorrectionLog();
    readonly trace = new authz.TraceStore();
    private readonly sessionId?: string;
    private readonly roundClean: boolean;

    constructor(opts: V5ContextOptions = {}) {
        this.sessionId = opts.sessionId;
        this.roundClean = opts.roundClean ?? true;
    }

    decisionContext(): authz.DecisionContext {
        return {
            isBlocked: (op) => this.blocked.has(op.target),
            memoryHit: (op) => this.memory.has(op.target, { sessionId: this.sessionId }),
            routineHit: (op) =>
                this.routine.isRoutine(
                    {
                        action: op.action,
                        objectClass: op.object,
                        targetBinding: op.target,
                        q1: op.q1,
                    },
                    { hazard: authz.isHazard(op) },
                ),
            passthrough: (op) => authz.isPassthrough(op, { roundClean: this.roundClean }),
        };
    }
}
