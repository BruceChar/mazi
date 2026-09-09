import { execFile } from "node:child_process";
import { promisify } from 'node:util';
import type { ToolResult } from "@mazi/core";

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

export const runcli = async (
  command: string,
  args: string[],
  options?: RunCliOptions,
): Promise<ToolResult> => {
  try {
    return await execFilePromise(command, args, options);
  } catch (error) {
    throw new Error(
      `Failed to execute command: ${command} ${args.join(" ")}\nError: ${error}`,
    );
  }
};
