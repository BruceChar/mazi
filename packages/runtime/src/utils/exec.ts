import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFilePromise = promisify(execFile);

export interface RunCliOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
    killSignal?: NodeJS.Signals | number;
    signal?: AbortSignal;
    encoding?: string | null;
}

/** execFile 原生结果（stdout/stderr；默认 encoding 下为 string） */
export type RunCliResult = Awaited<ReturnType<typeof execFilePromise>>;

export const runcli = async (
    command: string,
    args: string[],
    options?: RunCliOptions,
): Promise<RunCliResult> => {
    try {
        return await execFilePromise(command, args, options);
    } catch (error) {
        throw new Error(`Failed to execute command: ${command} ${args.join(' ')}\nError: ${error}`);
    }
};
