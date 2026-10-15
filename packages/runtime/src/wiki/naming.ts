import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

/** wiki 根目录名（相对 MAZI_HOME）：$MAZI_HOME/wiki（设计 §4.1）。 */
export const WIKI_DIR_NAME = 'wiki';
/** 单文件 wiki 名（设计 §4.2）。 */
export const WIKI_FILE_NAME = 'wiki.md';
/** 项目索引文件名（项目名 → 工作区；重名消歧用）。 */
export const WIKI_INDEX_FILE_NAME = 'index.json';

export interface WikiProjectIndexEntry {
    workspace: string;
    updatedAt?: string;
}

export type WikiProjectIndex = Record<string, WikiProjectIndexEntry>;

/** 工作区 → 归一化绝对路径（空串原样返回）。 */
export function normalizeWorkspace(workspace: string): string {
    const trimmed = workspace.trim();
    if (trimmed.length === 0) return '';
    return resolve(trimmed);
}

export function isSameWorkspace(left: string, right: string): boolean {
    const normalized = normalizeWorkspace(left);
    return normalized.length > 0 && normalized === normalizeWorkspace(right);
}

/** 工作区目录名 → slug（保留中英文/数字/._-，其余折叠为 '-'）。 */
export function slugifyProjectName(workspace: string): string {
    const base = basename(normalizeWorkspace(workspace));
    const slug = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
    return slug.length > 0 ? slug : 'workspace';
}

/** 工作区路径短 hash（重名消歧用）。 */
export function workspaceHash(workspace: string): string {
    return createHash('sha1').update(normalizeWorkspace(workspace)).digest('hex').slice(0, 8);
}

/**
 * 项目名：工作区目录名；同名不同路径时追加 4 位短 hash，仍冲突则延长 hash（设计 §5）。
 */
export function projectNameFor(workspace: string, index: WikiProjectIndex): string {
    const base = slugifyProjectName(workspace);
    const taken = index[base];
    if (taken === undefined || isSameWorkspace(taken.workspace, workspace)) return base;
    const hash = workspaceHash(workspace);
    for (let length = 4; length <= hash.length; length += 2) {
        const candidate = base + '-' + hash.slice(0, length);
        const entry = index[candidate];
        if (entry === undefined || isSameWorkspace(entry.workspace, workspace)) return candidate;
    }
    return base + '-' + hash;
}

export function wikiRoot(home: string): string {
    return join(home, WIKI_DIR_NAME);
}

export function wikiIndexFile(home: string): string {
    return join(wikiRoot(home), WIKI_INDEX_FILE_NAME);
}

export function wikiDirFor(home: string, project: string): string {
    return join(wikiRoot(home), project);
}

export function wikiFileFor(home: string, project: string): string {
    return join(wikiDirFor(home, project), WIKI_FILE_NAME);
}
