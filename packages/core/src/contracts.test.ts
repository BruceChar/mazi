import { describe, expect, expectTypeOf, it } from 'vitest';
import { ulid } from './index';

/**
 * core 契约与总体设计 v1.2 的回归哨兵（MVP 文档 F2.1）：
 * 编译期断言关键字段/联合类型，运行期断言 ULID 生成器行为。
 */

describe('Session/Turn/Step 契约（v1.2 §3.1）', () => {
    it('Session 关键字段与联合类型对齐 v1.2', () => {
        expectTypeOf<Session>().toMatchTypeOf<{
            sessionId: string;
            rawIntent: string;
            turns: Turn[];
            state: SessionState;
            flagSnapshot: FlagSnapshot;
        }>();
        expectTypeOf<SessionState>().toEqualTypeOf<
            'initializing' | 'running' | 'paused' | 'succeeded' | 'failed' | 'aborted'
        >();
        expectTypeOf<StepKind>().toEqualTypeOf<'thinking' | 'tool_call' | 'observation'>();
        expectTypeOf<Step['status']>().toEqualTypeOf<
            'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'blocked'
        >();
    });
});

describe('Goal/Turn 两级契约（v1.2 §3.2）', () => {
    it('GoalContract 与 TurnContract 字段对齐', () => {
        expectTypeOf<GoalContract>().toMatchTypeOf<{
            allowedTools: string[] | 'all-registry';
            permissionCeiling: PermissionLevel;
            budget: GlobalBudget;
            termination: TerminationSpec;
            rollbackPolicy: RollbackPolicy;
        }>();
        expectTypeOf<TurnContract>().toMatchTypeOf<{
            tags: TaskTag[];
            requiredTools: ToolRequirement[];
            maxPermission: PermissionLevel;
            budget: BudgetSlice;
            failureSignals: FailureSignal[];
        }>();
        // 路由信号下沉：GoalContract 不得携带 tags 路由字段（v1.2 验收 #4）
        expectTypeOf<GoalContract>().not.toMatchTypeOf<{ tags: unknown[] }>();
    });
});

describe('Usage 双层统计（v1.2 §3.5）', () => {
    it('Usage 四段结构与 Token 分类对齐', () => {
        expectTypeOf<Usage>().toMatchTypeOf<{
            vendor: VendorUsage;
            runtime: RuntimeContextBreakdown;
            cost: CostBreakdown;
            timing: UsageTiming;
        }>();
        expectTypeOf<VendorUsage>().toMatchTypeOf<{
            inputTokens: number;
            outputTokens: number;
            reportedByVendor: boolean;
        }>();
        expectTypeOf<RuntimeContextBreakdown>().toMatchTypeOf<{
            systemPromptRatio: number;
            totalContextTokens: number;
            contextWindowUtilization: number;
            contextDeltaFromPrev: number;
        }>();
    });
});

describe('用户交互记录（v1.2 §3.8 / v1.2 调整项）', () => {
    it('rawInput 原样保留；userId 可选（匿名化场景可省略）', () => {
        expectTypeOf<UserInteractionRecord>().toMatchTypeOf<{
            rawInput: string;
            inputTimestamp: number;
            feedback: UserFeedback[];
            status: 'recording' | 'completed';
        }>();
        expectTypeOf<UserInteractionRecord['userId']>().toEqualTypeOf<string | undefined>();
    });
    it('UserFeedback 覆盖 v1.2 的四种反馈类型', () => {
        expectTypeOf<UserFeedback['type']>().toEqualTypeOf<
            'decision_change' | 'authorization' | 'output_rating' | 'text_feedback'
        >();
    });
});

describe('ToolRegistry / ToolInvoker（F2.1 新增接口）', () => {
    it('工具解析结果区分 required/optional 缺失', () => {
        expectTypeOf<ToolResolution>().toMatchTypeOf<{
            tools: ToolSpec[];
            missingRequired: string[];
            missingOptional: string[];
        }>();
    });
    it('工具执行结果为可判别联合，无 null 返回值（AGENT.md）', () => {
        expectTypeOf<ToolExecutionResult>().toEqualTypeOf<
            | { ok: true; content: string; data?: unknown }
            | { ok: false; error: string; retryable?: boolean }
        >();
    });
});

describe('ulid 生成器（F2.1 新增运行时工具）', () => {
    it('生成 26 字符、Crockford Base32 字符集、两两不同且单调有序', () => {
        const charset = /^[0-9A-HJKMNP-TV-Z]{26}$/;
        const a = ulid();
        const b = ulid();
        expect(a).toMatch(charset);
        expect(b).toMatch(charset);
        expect(a).not.toBe(b);
        // 时间戳前缀单调：同毫秒内后生成者字典序 >= 先生成者
        expect(b >= a).toBe(true);
    });
});

import type { PermissionLevel, ToolSpec } from './capacity';
// 供 expectTypeOf 引用的类型导入（类型级引用，不产生运行时副作用）
import type { FlagSnapshot } from './flags';
import type { GlobalBudget, GoalContract, RollbackPolicy, TerminationSpec } from './goal';
import type { Session, SessionState, Step, StepKind, Turn } from './session';
import type { ToolExecutionResult, ToolResolution } from './tool';
import type {
    BudgetSlice,
    FailureSignal,
    TaskTag,
    ToolRequirement,
    TurnContract,
} from './turn-contract';
import type {
    CostBreakdown,
    RuntimeContextBreakdown,
    Usage,
    UsageTiming,
    VendorUsage,
} from './usage';
import type { UserFeedback, UserInteractionRecord } from './user-interaction';
