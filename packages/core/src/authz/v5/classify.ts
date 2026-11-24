/**
 * V5 对象分类器（§4 表 / D13 envelope）。
 *
 * 输入由调用方提供的目标事实（git 状态、工作区边界、标记），分类器不直接
 * 访问文件系统。unknown 按 unproven 对待（按 irreversible 进 hazard）；
 * envelope 拿不准时由调用侧保守处理，静态清单只作提示不作判定。
 */

import type { ObjectClass, Q1 } from './decision.js';

/** 调用方采集的目标事实；布尔缺失按 false 保守处理。 */
export interface TargetFacts {
    path: string;
    /** 目标是否在工作区根内。 */
    insideWorkspace: boolean;
    /** git tracked（已纳入版本控制且非忽略）。 */
    gitTracked: boolean;
    /** tracked 文件存在未提交改动。 */
    hasUncommittedChanges: boolean;
    /** gitignore 命中 / 生成目录。 */
    gitignored: boolean;
    /** 用户标记敏感区。 */
    sensitive: boolean;
    /** .git/、备份、恢复能力区。 */
    critical: boolean;
}

export interface Classification {
    object: ObjectClass;
    q1: Q1;
    envelope: boolean;
}

/**
 * 能力边界路径清单（§13）：写入改变的是"哪些代码/凭证/钩子将来会被自动执行"。
 * 只作提示，不作唯一判定；清单外拿不准 → envelope=true（调用侧保守）。
 */
const ENVELOPE_PATTERNS: readonly RegExp[] = [
    /(^|\/)\.husky\//,
    /(^|\/)\.git\/hooks\//,
    /(^|\/)\.github\/workflows\//,
    /(^|\/)\.gitlab-ci\.yml$/,
    /(^|\/)\.circleci\//,
    /(^|\/)\.pre-commit-config\.yaml$/,
    /(^|\/)\.bashrc$/,
    /(^|\/)\.zshrc$/,
    /(^|\/)\.profile$/,
    /(^|\/)\.bash_profile$/,
    /(^|\/)\.config\/fish\//,
    /(^|\/)authorized_keys$/,
    /(^|\/)\.crontab$/,
    /(^|\/)\/etc\/crontab$/,
    /(^|\/)\/var\/spool\/cron\//,
    /(^|\/)\.config\/systemd\//,
    /(^|\/)\/etc\/systemd\//,
    /(^|\/)\.gitconfig$/,
    /(^|\/)\.npmrc$/,
    /(^|\/)\.yarnrc$/,
    /(^|\/)\.envrc$/,
];

/** 路径是否命中能力边界清单（仅提示）。 */
export function isEnvelopePath(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    return ENVELOPE_PATTERNS.some((re) => re.test(normalized));
}

export function classifyTarget(facts: TargetFacts): Classification {
    const envelope = isEnvelopePath(facts.path);
    // critical 最先：.git/、备份、恢复区，不可逆。
    if (facts.critical) return { object: 'critical', q1: 'irreversible', envelope };
    // external：工作区外，读/写/删/执行均 hazard。
    if (!facts.insideWorkspace) {
        return { object: 'external', q1: facts.gitignored ? 'reversible' : 'unproven', envelope };
    }
    if (facts.sensitive) return { object: 'sensitive', q1: 'compensable', envelope };
    if (facts.gitignored) return { object: 'build_artifact', q1: 'reversible', envelope };
    if (facts.gitTracked && facts.hasUncommittedChanges) {
        return { object: 'source_dirty', q1: 'irreversible', envelope };
    }
    if (facts.gitTracked) return { object: 'source', q1: 'compensable', envelope };
    // 工作区内既未 tracked 也未忽略：分类器拿不准 → unknown / unproven。
    return { object: 'unknown', q1: 'unproven', envelope };
}
