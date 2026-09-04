import { createInterface } from 'node:readline';
import type { RuntimeConfig } from '@mazi/harness-runtime';
import { HarnessRuntime } from '@mazi/harness-runtime';
import { parseCli } from './args.js';
import { loadConfig } from './config.js';

async function askRating(runtime: HarnessRuntime, sessionId: string): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
        rl.question('请评价本次结果 (1-5，输入数字评分或回车跳过): ', resolve);
    });
    rl.close();
    const rating = Number.parseInt(answer.trim(), 10);
    if (Number.isNaN(rating) || rating < 1 || rating > 5) {
        return;
    }
    runtime.recordFeedback(sessionId, {
        timestamp: Date.now(),
        type: 'output_rating',
        rating,
        content: 'CLI 交互评分',
    });
}

export async function main(argv: string[]): Promise<number> {
    const opts = parseCli(argv);
    const fileConfig = loadConfig(opts.configDir);
    const config: RuntimeConfig = {
        ...fileConfig,
        eventDir: opts.eventDir ?? fileConfig.eventDir,
        dbPath: opts.dbPath ?? fileConfig.dbPath,
        consoleEnabled: true,
    };
    if (config.providers.length === 0) {
        process.stderr.write(
            '未配置 providers：请在 config/providers.json 提供至少一个 provider\n',
        );
        return 2;
    }
    const runtime = new HarnessRuntime(config);
    try {
        process.stdout.write(`[session] 开始执行：${opts.input}\n`);
        const result = await runtime.run(opts.input, { userId: opts.userId });
        process.stdout.write('\n[result]\n');
        process.stdout.write(`  outcome: ${result.outcome ?? 'n/a'}\n`);
        if (result.summary) {
            process.stdout.write(`  summary: ${result.summary.slice(0, 2000)}\n`);
        }
        process.stdout.write(
            `  turns: ${result.turnCount} | tokens: ${result.totalTokens} | costUsd: ${result.totalCostUsd.toFixed(6)}\n`,
        );
        if (opts.interactive) {
            await askRating(runtime, result.sessionId);
        }
        return result.outcome === 'success' ? 0 : 1;
    } finally {
        await runtime.close();
    }
}
