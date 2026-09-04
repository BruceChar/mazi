import type { LLMDriver, LLMRequest, LLMResponse, LLMStreamEvent, VendorUsage } from '@mazi/core';
import type { ScriptedRound } from './registry.js';

/** ScriptedDriver 构造选项 */
export interface ScriptedDriverOptions {
    /** 脚本轮次：stream() 依序消费一轮；round 用尽后重复最后一轮 */
    rounds: ScriptedRound[];
    /**
     * 故障模拟（>0）：前 failCalls 次 stream() 调用直接抛 Error('scripted-fail')。
     * 失败的调用不消费 round，也不计入 complete() 的已消费文本。
     */
    failCalls?: number;
}

/** 汇总已消费轮次的 usage（未声明 usage 的轮按 0 计，并使 reportedByVendor=false） */
function aggregateUsage(rounds: ScriptedRound[]): VendorUsage {
    let inputTokens = 0;
    let outputTokens = 0;
    let reportedByVendor = rounds.length > 0;
    for (const round of rounds) {
        const usage = round.usage;
        if (!usage) {
            reportedByVendor = false;
            continue;
        }
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        reportedByVendor = reportedByVendor && usage.reportedByVendor;
    }
    return { inputTokens, outputTokens, reportedByVendor };
}

/**
 * 确定性脚本驱动（零真实厂商；MVP 默认与测试驱动，MVP 设计文档 §3.2/D3、§8 F5）。
 *
 * - stream()：每次调用消费下一个 round（内部计数从 0 开始）；round 用尽后
 *   重复最后一个 round（文档约定）。
 * - 每轮事件顺序固定：reasoning-delta（有 reasoning 时，整段一次）→
 *   text-delta（有 text 时，整段一次）→ 每个 toolCall 一条 tool-call →
 *   usage（round.usage 缺省给 { inputTokens: 0, outputTokens: 0,
 *   reportedByVendor: false }）→ end（finishReason ?? 'stop'）。
 * - complete()：不消费新 round、不受 failCalls 影响；返回"已消费 round 的
 *   text 拼接"（合成文本），并附 usage 汇总。
 * - rounds 为空时构造即抛错：配置错误应尽早暴露。
 */
export class ScriptedDriver implements LLMDriver {
    private readonly rounds: ScriptedRound[];

    /** 剩余故障次数：>0 时 stream() 直接抛 Error('scripted-fail') */
    private failRemaining: number;

    /** 已成功消费的轮次数（仅 stream() 成功返回时递增） */
    private consumed = 0;

    constructor(options: ScriptedDriverOptions) {
        if (options.rounds.length === 0) {
            throw new Error('ScriptedDriver: rounds 为空，无法播放脚本场景');
        }
        this.rounds = options.rounds;
        this.failRemaining = Math.max(0, options.failCalls ?? 0);
    }

    /** 流式调用：消费下一个 round 并按固定顺序产出 LLMStreamEvent */
    stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
        if (this.failRemaining > 0) {
            this.failRemaining -= 1;
            throw new Error('scripted-fail');
        }
        const index = Math.min(this.consumed, this.rounds.length - 1);
        const round = this.rounds[index];
        this.consumed += 1;
        return this.play(round);
    }

    /** 非流式调用：拼接所有已消费 round 的 text（不消费新 round） */
    async complete(_req: LLMRequest): Promise<LLMResponse> {
        const consumedRounds = this.rounds.slice(0, this.consumed);
        const lastRound = consumedRounds[consumedRounds.length - 1];
        const response: LLMResponse = {
            content: consumedRounds.map((round) => round.text ?? '').join(''),
        };
        if (lastRound) {
            response.finishReason = lastRound.finishReason ?? 'stop';
            response.usage = aggregateUsage(consumedRounds);
        }
        return response;
    }

    private async *play(round: ScriptedRound): AsyncGenerator<LLMStreamEvent> {
        if (round.reasoning) {
            yield { type: 'reasoning-delta', delta: round.reasoning };
        }
        if (round.text) {
            yield { type: 'text-delta', delta: round.text };
        }
        for (const toolCall of round.toolCalls ?? []) {
            yield {
                type: 'tool-call',
                callId: toolCall.callId,
                toolName: toolCall.toolName,
                arguments: toolCall.arguments,
            };
        }
        yield {
            type: 'usage',
            usage: round.usage ?? { inputTokens: 0, outputTokens: 0, reportedByVendor: false },
        };
        yield { type: 'end', finishReason: round.finishReason ?? 'stop' };
    }
}
