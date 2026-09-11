// logger.ts
import type { Writable } from 'node:stream';

/** ANSI 颜色常量 */
const Colors = {
    reset: '\x1b[0m',
    gray: '\x1b[90m',
    blue: '\x1b[34m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
    ts: number;
    level: LogLevel;
    module: string;
    message: string;
}

const LOG_BUFFER_MAX = 1000;
const logBuffer: LogEntry[] = [];

function record(level: LogLevel, moduleName: string, message: string): void {
    logBuffer.push({ ts: Date.now(), level, module: moduleName, message });
    if (logBuffer.length > LOG_BUFFER_MAX) {
        logBuffer.splice(0, logBuffer.length - LOG_BUFFER_MAX);
    }
}

/** 进程内最近日志（系统错误/告警/信息），供 UI「日志 / 事件」面板查看。 */
export function recentLogs(limit = 500): LogEntry[] {
    return logBuffer.slice(-limit);
}

class Logger {
    private readonly moduleName: string;
    private readonly out: Writable;

    constructor(moduleName: string, out: Writable = process.stdout) {
        this.moduleName = moduleName;
        this.out = out;
    }

    /** 普通日志 INFO：绿色 */
    log(msg: string): void {
        record('info', this.moduleName, msg);
        const ts = new Date().toISOString();
        const line = `${ts} ${this.moduleName} ${Colors.green}[INFO]${Colors.reset} ${msg}\n`;
        this.out.write(line);
    }

    /** DEBUG：灰色，仅 local/dev 输出 */
    debug(msg: string): void {
        const env = process.env.NODE_ENV;
        if (env !== 'local' && env !== 'dev') return;
        record('debug', this.moduleName, msg);

        const ts = new Date().toISOString();
        const line = `${ts} ${this.moduleName} ${Colors.blue}[DEBUG]${Colors.reset} ${msg}\n`;
        this.out.write(line);
    }

    /** WARN：黄色（额外新增） */
    warn(msg: string): void {
        record('warn', this.moduleName, msg);
        const ts = new Date().toISOString();
        const line = `${ts} ${this.moduleName} ${Colors.yellow}[WARN]${Colors.reset} ${msg}\n`;
        this.out.write(line);
    }

    /** ERROR：红色，stdout（如果你想stderr可以改成 process.stderr.write） */
    error(msg: string): void {
        record('error', this.moduleName, msg);
        const ts = new Date().toISOString();
        const line = `${ts} ${this.moduleName} ${Colors.red}[ERROR]${Colors.reset} ${msg}\n`;
        process.stderr.write(line);
    }
}

export default Logger;
