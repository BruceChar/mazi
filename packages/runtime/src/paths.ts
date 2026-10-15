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
/** 用户级技能目录（skills 资产，不进代码仓库）。 */
export const HOME_SKILLS_DIR = 'skills';
/** 技能挂载状态文件（用户级开关）。 */
export const HOME_SKILLS_STATE_FILE = 'skills.json';
/** 特性开关定义文件（用户资产；见 docs/AB测试设计.md §3）。 */
export const HOME_FEATURES_FILE = 'features.json';
/** 对照实验日志目录（一次实验一个 JSONL；见 docs/AB测试设计.md §6）。 */
export const HOME_EXPERIMENTS_DIR = 'experiments';
/** 项目 wiki 根目录（项目级状态快照 + 变更日志；见 docs/项目wiki设计.md §4）。 */
export const HOME_WIKI_DIR = 'wiki';
/** 实验独立 Goal 库文件名（相对于 experiments 目录；与主会话 mazi.db 分离）。 */
export const HOME_EXPERIMENTS_DB_FILE = 'mazi.db';
/** 实验独立事件目录名（相对于 experiments 目录；与主会话 events 分离）。 */
export const HOME_EXPERIMENTS_EVENT_DIR = 'events';

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
    /** 用户级技能目录（$MAZI_HOME/skills）。 */
    skillsDir: string;
    /** 技能挂载状态文件（$MAZI_HOME/skills.json）。 */
    skillStateFile: string;
    /** 特性开关定义文件（$MAZI_HOME/features.json）。 */
    featuresFile: string;
    /** 对照实验日志目录（$MAZI_HOME/experiments）。 */
    experimentsDir: string;
    /** 实验独立 Goal 库（$MAZI_HOME/experiments/mazi.db）：不与主会话共用 Goal 树。 */
    experimentsDbFile: string;
    /** 实验独立事件目录（$MAZI_HOME/experiments/events）。 */
    experimentsEventDir: string;
    /** 项目 wiki 根目录（$MAZI_HOME/wiki；键为项目名）。 */
    wikiDir: string;
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
        skillsDir: join(home, HOME_SKILLS_DIR),
        skillStateFile: join(home, HOME_SKILLS_STATE_FILE),
        featuresFile: join(home, HOME_FEATURES_FILE),
        experimentsDir: join(home, HOME_EXPERIMENTS_DIR),
        experimentsDbFile: join(home, HOME_EXPERIMENTS_DIR, HOME_EXPERIMENTS_DB_FILE),
        experimentsEventDir: join(home, HOME_EXPERIMENTS_DIR, HOME_EXPERIMENTS_EVENT_DIR),
        wikiDir: join(home, HOME_WIKI_DIR),
    };
}

/** 确保 home 目录树存在（config 根 + events） */
export function ensureMaziDirs(home = maziHome()): MaziPaths {
    const paths = maziPaths(home);
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.eventDir, { recursive: true });
    mkdirSync(paths.behaviorDir, { recursive: true });
    mkdirSync(paths.authConfigDir, { recursive: true });
    mkdirSync(paths.skillsDir, { recursive: true });
    mkdirSync(paths.experimentsDir, { recursive: true });
    mkdirSync(paths.experimentsEventDir, { recursive: true });
    mkdirSync(paths.wikiDir, { recursive: true });
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
