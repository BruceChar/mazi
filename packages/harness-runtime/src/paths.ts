import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户目录根：MAZI_HOME 环境变量可覆盖，缺省 ~/.mazi（设计文档 UserConfigWebUI v0.1 §1） */
export function maziHome(): string {
    const override = process.env.MAZI_HOME;
    return override && override.length > 0 ? override : join(homedir(), '.mazi');
}

export const HOME_FILE_PROVIDERS = 'providers.json';
export const HOME_FILE_TOOLS = 'tools.json';
export const HOME_FILE_FLAGS = 'flags.json';
export const HOME_DB_FILE = 'mazi.db';
export const HOME_EVENTS_DIR = 'events';

export interface MaziPaths {
    home: string;
    providersFile: string;
    toolsFile: string;
    flagsFile: string;
    dbPath: string;
    eventDir: string;
}

export function maziPaths(home = maziHome()): MaziPaths {
    return {
        home,
        providersFile: join(home, HOME_FILE_PROVIDERS),
        toolsFile: join(home, HOME_FILE_TOOLS),
        flagsFile: join(home, HOME_FILE_FLAGS),
        dbPath: join(home, HOME_DB_FILE),
        eventDir: join(home, HOME_EVENTS_DIR),
    };
}

/** 确保 home 目录树存在（config 根 + events） */
export function ensureMaziDirs(home = maziHome()): MaziPaths {
    const paths = maziPaths(home);
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.eventDir, { recursive: true });
    return paths;
}

/** 默认配置根（= MAZI_HOME）：cli config-dir 缺省值 */
export function defaultConfigDir(): string {
    return maziHome();
}

/** 默认事件目录：MAZI_HOME/events */
export function defaultEventDir(): string {
    return maziPaths().eventDir;
}

/** 默认 SQLite 路径：MAZI_HOME/mazi.db */
export function defaultDbPath(): string {
    return maziPaths().dbPath;
}
