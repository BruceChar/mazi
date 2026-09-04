import { parseArgs } from 'node:util';

export interface CliOptions {
    command: 'run' | 'config';
    /** run 命令的任务输入；config 命令为空 */
    input: string;
    userId?: string;
    configDir: string;
    interactive: boolean;
    eventDir?: string;
    dbPath?: string;
}

export function parseCli(argv: string[]): CliOptions {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            user: { type: 'string' },
            'config-dir': { type: 'string', default: 'config' },
            interactive: { type: 'boolean', default: false },
            'event-dir': { type: 'string' },
            db: { type: 'string' },
            help: { type: 'boolean', default: false },
        },
    });
    if (values.help) {
        printHelp();
        process.exit(0);
    }
    if (positionals[0] !== 'run' && positionals[0] !== 'config') {
        printHelp();
        process.exit(2);
    }
    const command = positionals[0] as 'run' | 'config';
    const input = positionals[1] ?? '';
    if (command === 'run' && !input) {
        process.stderr.write('缺少任务输入：mazi run "<任务描述>"\n');
        process.exit(2);
    }
    return {
        command,
        input,
        userId: values.user,
        configDir: values['config-dir'] ?? 'config',
        interactive: values.interactive === true,
        eventDir: values['event-dir'],
        dbPath: values.db,
    };
}

function printHelp(): void {
    const help = `mazi - AI Agent Harness MVP CLI

用法:
  mazi run "<任务描述>" [选项]      # 执行一个任务
  mazi config [选项]               # 交互式配置 provider（生成 providers/tools/flags json）

选项:
  --user <id>        用户标识（写入交互记录）
  --config-dir <dir>  配置目录（默认 ./config：providers.json/tools.json/flags.json）
  --interactive       执行后提示用户评分反馈
  --event-dir <dir>   事件 JSONL 目录
  --db <path>         SQLite 文件路径
  --help              帮助

说明:
  run    读取 OPENAI_API_KEY / DEEPSEEK_API_KEY 等默认环境变量（pi-ai driver）
  config 交互式选择 provider 与模型并检测 key 环境变量
`;
    process.stdout.write(`${help}\n`);
}
