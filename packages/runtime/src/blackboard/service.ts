import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { renderBlackboard, renderBlackboardInjection } from './injector.js';
import type { BlackboardStore } from './store.js';
import type {
    BlackboardEvidence,
    BlackboardRunUpdate,
    BlackboardSection,
    ProjectBlackboard,
} from './types.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.next', 'coverage']);

function uniquePush(values: string[], value: string, limit: number): void {
    const normalized = value.trim();
    if (normalized.length === 0 || values.includes(normalized)) return;
    values.push(normalized);
    if (values.length > limit) values.splice(0, values.length - limit);
}

function readPackage(workspace: string): Record<string, unknown> | undefined {
    try {
        return JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) as Record<
            string,
            unknown
        >;
    } catch {
        return undefined;
    }
}

function readReadme(workspace: string): { path?: string; text: string } {
    for (const name of ['README.md', 'README.MD', 'readme.md']) {
        const path = join(workspace, name);
        if (!existsSync(path)) continue;
        try {
            return { path, text: readFileSync(path, 'utf8').slice(0, 8000) };
        } catch {
            return { text: '' };
        }
    }
    return { text: '' };
}

function topDirectories(workspace: string): string[] {
    try {
        return readdirSync(workspace, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !IGNORED.has(entry.name))
            .map((entry) => entry.name)
            .sort()
            .slice(0, 30);
    } catch {
        return [];
    }
}

function gitHead(workspace: string): string | undefined {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: workspace,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return undefined;
    }
}

export class ProjectBlackboardService {
    constructor(
        private readonly store: BlackboardStore,
        private readonly now: () => number = Date.now,
    ) {}

    async ensure(projectId: string, workspace: string): Promise<ProjectBlackboard> {
        const existing = await this.store.load(projectId);
        if (existing !== undefined) {
            const marker = '项目源指纹变化，黑板章节需要在执行前复核';
            if (
                existing.sourceFingerprint !== this.fingerprint(workspace) &&
                !existing.knownIssues.includes(marker)
            ) {
                uniquePush(existing.knownIssues, marker, 20);
                existing.updatedAt = this.now();
                existing.version += 1;
                await this.store.save(existing);
            }
            return existing;
        }
        const board = this.bootstrap(projectId, workspace);
        await this.store.save(board);
        return board;
    }

    async updateFromRun(
        projectId: string,
        workspace: string,
        update: BlackboardRunUpdate,
    ): Promise<ProjectBlackboard> {
        const board = await this.ensure(projectId, workspace);
        const now = update.now ?? this.now();
        board.activeGoals = board.activeGoals.filter((goal) => goal !== update.rootGoalId);
        if (!update.ok) {
            uniquePush(
                board.knownIssues,
                `${update.statement.slice(0, 120)}（${update.reason}）`,
                20,
            );
            uniquePush(board.nextActions, `处理失败任务：${update.statement.slice(0, 100)}`, 10);
        } else {
            uniquePush(
                board.completedMilestones,
                update.finalMessage?.trim() || update.statement.slice(0, 160),
                30,
            );
            uniquePush(
                board.recentChanges,
                `${update.statement.slice(0, 120)}（${update.taskTitles.length} 个 Task）`,
                20,
            );
        }
        for (const path of update.changedPaths ?? []) {
            uniquePush(board.recentChanges, `文件变化：${path}`, 20);
        }
        if (
            !board.evidenceRefs.some(
                (entry) => entry.kind === 'goal' && entry.ref === update.rootGoalId,
            )
        ) {
            board.evidenceRefs.push({
                kind: 'goal',
                ref: update.rootGoalId,
                verifiedAt: now,
            });
            if (board.evidenceRefs.length > 100) {
                board.evidenceRefs.splice(0, board.evidenceRefs.length - 100);
            }
        }
        board.lastVerifiedAt = now;
        board.sourceFingerprint = this.fingerprint(workspace);
        board.updatedAt = now;
        board.version += 1;
        await this.store.save(board);
        return board;
    }

    async reconcile(projectId: string, workspace: string): Promise<ProjectBlackboard> {
        const board = await this.ensure(projectId, workspace);
        const fingerprint = this.fingerprint(workspace);
        if (fingerprint !== board.sourceFingerprint) {
            uniquePush(board.recentChanges, '项目源指纹变化，黑板章节待复核', 20);
            board.sourceFingerprint = fingerprint;
            board.lastVerifiedAt = this.now();
            board.updatedAt = this.now();
            board.version += 1;
            await this.store.save(board);
        }
        return board;
    }

    async isStale(projectId: string, workspace: string): Promise<boolean> {
        const board = await this.store.load(projectId);
        return board === undefined || board.sourceFingerprint !== this.fingerprint(workspace);
    }

    promptFragment(board: ProjectBlackboard, budgetTokens = 700): string {
        return renderBlackboardInjection(board, budgetTokens);
    }

    read(board: ProjectBlackboard, section: BlackboardSection = 'all'): string {
        return renderBlackboard(board, section);
    }

    close(): void {
        this.store.close();
    }

    private bootstrap(projectId: string, workspace: string): ProjectBlackboard {
        const root = resolve(workspace);
        const pkg = readPackage(root);
        const readme = readReadme(root);
        const modules = topDirectories(root);
        const dependencies =
            pkg?.dependencies !== undefined && typeof pkg.dependencies === 'object'
                ? Object.keys(pkg.dependencies as Record<string, unknown>)
                : [];
        const devDependencies =
            pkg?.devDependencies !== undefined && typeof pkg.devDependencies === 'object'
                ? Object.keys(pkg.devDependencies as Record<string, unknown>)
                : [];
        const name =
            typeof pkg?.name === 'string' && pkg.name.length > 0 ? pkg.name : basename(root);
        const purpose =
            typeof pkg?.description === 'string' && pkg.description.length > 0
                ? pkg.description
                : readme.text.match(/^#\s+(.+)$/m)?.[1]?.trim() || `${name} 项目`;
        const now = this.now();
        const evidence: BlackboardEvidence[] = [
            ...(readme.path !== undefined
                ? [{ kind: 'file' as const, ref: readme.path, verifiedAt: now }]
                : []),
            ...(pkg !== undefined
                ? [{ kind: 'file' as const, ref: join(root, 'package.json'), verifiedAt: now }]
                : []),
        ];
        const head = gitHead(root);
        if (head !== undefined) evidence.push({ kind: 'git', ref: head, verifiedAt: now });
        return {
            projectId,
            workspaceRef: root,
            name,
            purpose,
            status: 'active',
            architectureSummary:
                modules.length > 0 ? `顶层结构：${modules.join('、')}` : '尚未识别项目顶层结构',
            stack: [...new Set([...dependencies, ...devDependencies])].slice(0, 30),
            coreModules: modules,
            interfaces: [],
            constraints: [],
            activeGoals: [],
            completedMilestones: [],
            knownIssues: [],
            decisions: [],
            nextActions: ['根据当前目标继续工作并补充项目证据'],
            recentChanges: ['初始化项目黑板'],
            evidenceRefs: evidence,
            lastVerifiedAt: now,
            sourceFingerprint: this.fingerprint(root),
            version: 1,
            updatedAt: now,
        };
    }

    private fingerprint(workspace: string): string {
        const root = resolve(workspace);
        const parts: string[] = [gitHead(root) ?? 'no-git'];
        for (const file of ['package.json', 'README.md', 'README.MD', 'readme.md']) {
            const path = join(root, file);
            if (!existsSync(path)) continue;
            try {
                parts.push(createHash('sha256').update(readFileSync(path)).digest('hex'));
            } catch {
                // unreadable source does not invalidate the existing board
            }
        }
        return createHash('sha256').update(parts.join('\n')).digest('hex');
    }
}
