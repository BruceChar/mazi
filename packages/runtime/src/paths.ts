import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 用户目录根：MAZI_HOME 环境变量可覆盖（支持 ~ 前缀展开），缺省 ~/.mazi（设计文档 UserConfigWebUI v0.1 §1） */
export function maziHome(): string {
    const override = process.env.MAZI_HOME;
    return override && override.length > 0 ? expandHome(override) : join(homedir(), '.mazi');
}

/** 展开前导 ~：'~' → <homedir>，'~/x' → <homedir>/x；其余原样返回 */
function expandHome(path: string): string {
    if (path === '~') return homedir();
    if (path.startsWith('~/')) return join(homedir(), path.slice(2));
    return path;
}

export const HOME_FILE_PROVIDERS = 'providers.json';
export const HOME_FILE_TOOLS = 'tools.json';
export const HOME_FILE_FLAGS = 'flags.json';
export const HOME_FILE_SETTINGS = 'settings.json';
/** 密钥文件（不进 configOverview；写入时权限 0600）。 */
export const HOME_FILE_SECRETS = 'secrets.json';
export const HOME_DB_FILE = 'mazi.db';
export const HOME_EVENTS_DIR = 'events';
export const HOME_BEHAVIOR_DIR = 'behavior';
/** Auth 治理配置目录（命令分类规则等）；可用 MAZI_AUTH_CONFIG_DIR 覆盖。 */
export const HOME_AUTH_DIR = 'config/auth';
/** 问题标签分类法注册表（config/question-taxonomy.json；缺省用内置默认）。 */
export const HOME_QUESTION_TAXONOMY_FILE = 'config/question-taxonomy.json';
export const AUTH_COMMAND_POLICY_FILE = 'commands.json';

export interface MaziPaths {
    home: string;
    providersFile: string;
    toolsFile: string;
    flagsFile: string;
    settingsFile: string;
    secretsFile: string;
    dbPath: string;
    eventDir: string;
    /** 用户行为流导出/迁移目录（权威库在 SQLite；见 docs/用户问题标签与分类设计.md §4）。 */
    behaviorDir: string;
    /** 问题标签分类法注册表（可覆盖；缺省内置）。 */
    questionTaxonomyFile: string;
    /** Auth 治理配置目录（命令分类规则等）。 */
    authConfigDir: string;
    /** 命令分类规则文件（默认 commands.json）。 */
    authCommandPolicyFile: string;
}

export function maziPaths(home = maziHome()): MaziPaths {
    const authOverride = process.env.MAZI_AUTH_CONFIG_DIR;
    const authConfigDir =
        authOverride && authOverride.length > 0
            ? expandHome(authOverride)
            : join(home, HOME_AUTH_DIR);
    return {
        home,
        providersFile: join(home, HOME_FILE_PROVIDERS),
        toolsFile: join(home, HOME_FILE_TOOLS),
        flagsFile: join(home, HOME_FILE_FLAGS),
        settingsFile: join(home, HOME_FILE_SETTINGS),
        secretsFile: join(home, HOME_FILE_SECRETS),
        dbPath: join(home, HOME_DB_FILE),
        eventDir: join(home, HOME_EVENTS_DIR),
        behaviorDir: join(home, HOME_BEHAVIOR_DIR),
        questionTaxonomyFile: join(home, HOME_QUESTION_TAXONOMY_FILE),
        authConfigDir,
        authCommandPolicyFile: join(authConfigDir, AUTH_COMMAND_POLICY_FILE),
    };
}

/** 确保 home 目录树存在（config 根 + events） */
export function ensureMaziDirs(home = maziHome()): MaziPaths {
    const paths = maziPaths(home);
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.eventDir, { recursive: true });
    mkdirSync(paths.behaviorDir, { recursive: true });
    mkdirSync(paths.authConfigDir, { recursive: true });
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

/** 默认用户行为流目录：MAZI_HOME/behavior */
export function defaultBehaviorDir(): string {
    return maziPaths().behaviorDir;
}

/** 默认 SQLite 路径：MAZI_HOME/mazi.db */
export function defaultDbPath(): string {
    return maziPaths().dbPath;
}
