import { createInterface } from 'node:readline';
import type { GoalRunResult, RuntimeConfig } from '@mazi/runtime';
import { HarnessRuntime } from '@mazi/runtime';
import { parseCli } from './args.js';
import { loadConfig } from './config.js';
import { runConfigure } from './configure.js';

async function askRating(runtime: HarnessRuntime, rootGoalId: string): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
        rl.question('请评价本次结果 (1-5，输入数字评分或回车跳过): ', resolve);
    });
    rl.close();
    const rating = Number.parseInt(answer.trim(), 10);
    if (Number.isNaN(rating) || rating < 1 || rating > 5) {
        return;
    }
    runtime.recordFeedback(rootGoalId, {
        timestamp: Date.now(),
        type: 'output_rating',
        rating,
        content: 'CLI 交互评分',
    });
}

function resultSummary(result: GoalRunResult): string | undefined {
    const last = result.tasks[result.tasks.length - 1];
    if (result.rejected && result.rejected.length > 0) {
        return result.rejected.join('；').slice(0, 2000);
    }
    const summary = last?.finalMessage ?? last?.errorMessage;
    return summary && summary.length > 0 ? summary.slice(0, 2000) : undefined;
}

export async function main(argv: string[]): Promise<number> {
    const opts = parseCli(argv);
    if (opts.command === 'config') {
        await runConfigure(opts.configDir);
        return 0;
    }
    // loadConfig 已按 MAZI_HOME 提供默认 db/events；显式 flag 优先
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
        const { rootGoalId, result } = await runtime.runGoalSession(opts.input, {
            userId: opts.userId,
        });
        process.stdout.write('\n[result]\n');
        process.stdout.write(`  goalId: ${rootGoalId}\n`);
        process.stdout.write(`  outcome: ${result.ok ? 'success' : 'failed'}\n`);
        const summary = resultSummary(result);
        if (summary) {
            process.stdout.write(`  summary: ${summary}\n`);
        }
        process.stdout.write(`  tasks: ${result.tasks.length}\n`);
        if (opts.interactive) {
            await askRating(runtime, rootGoalId);
        }
        return result.ok ? 0 : 1;
    } finally {
        await runtime.close();
    }
}
