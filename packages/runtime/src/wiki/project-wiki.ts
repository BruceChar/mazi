import { execFileSync } from 'node:child_process';
import {
    type Dirent,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    computeProjectWikiClaimOid,
    normalizeEvidenceInputs,
    normalizeProjectWikiClaimId,
    parseProjectWikiClaims,
    serializeProjectWikiClaims,
    withResolvedEvidence,
} from './project-wiki-claims.js';
import {
    detectProject,
    moduleWikiAgentsBlock,
    PROJECT_WIKI_AGENTS_END,
    PROJECT_WIKI_AGENTS_START,
    PROJECT_WIKI_ARCHITECTURE_TEMPLATE,
    PROJECT_WIKI_CLAIMS_TEMPLATE,
    PROJECT_WIKI_CONVENTIONS_TEMPLATE,
    PROJECT_WIKI_CURRENT_TEMPLATE,
    PROJECT_WIKI_DECISIONS_TEMPLATE,
    PROJECT_WIKI_LESSONS_TEMPLATE,
    projectWikiAgentsBlock,
    projectWikiCommandsTemplate,
    projectWikiDeploymentTemplate,
    renderProjectWikiIndex,
} from './project-wiki-templates.js';
import type {
    ProjectWikiActivity,
    ProjectWikiActivityInput,
    ProjectWikiClaim,
    ProjectWikiClaimCorrectionInput,
    ProjectWikiClaimForgetInput,
    ProjectWikiClaimInput,
    ProjectWikiClaimUpdateInput,
    ProjectWikiCommit,
    ProjectWikiDoc,
    ProjectWikiDoctorReport,
    ProjectWikiEvidenceInput,
    ProjectWikiOperationResult,
    ProjectWikiRepository,
    ProjectWikiSessionEndResult,
    ProjectWikiUpdatePlan,
    ProjectWikiVerificationFinding,
} from './project-wiki-types.js';

const ACTIVITY_START = '<!-- activity:start -->';
const ACTIVITY_END = '<!-- activity:end -->';
const ACTIVITY_COMMIT_SUBJECT = 'wiki(run): record session activity';
const HOOK_MARK = '# project-wiki gate';
const LINE_WARN = 150;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_DOCS = 300;

export interface ProjectWikiInitOptions {
    perModule?: boolean;
}

export interface ProjectWikiInitResult {
    root: string;
    created: string[];
    projectType: string;
    modules: string[];
}

export interface ProjectWikiServiceOptions {
    workspace: string;
    now?: () => Date;
}

export interface ProjectWikiCommandResult {
    ok: boolean;
    content: string;
    data?: unknown;
}

/**
 * Runtime-native, Git-backed Project Wiki.
 *
 * This service owns the durable knowledge file format and deterministic
 * operations previously implemented by wiki.py. It has no dependency on the
 * Skill layer and never commits user source changes.
 */
export class ProjectWikiService {
    readonly workspace: string;
    private readonly now: () => Date;

    constructor(options: ProjectWikiServiceOptions) {
        const requested = resolve(options.workspace);
        this.workspace = existsSync(requested) ? realpathSync(requested) : requested;
        this.now = options.now ?? (() => new Date());
    }

    get wikiRoot(): string {
        return join(this.workspace, 'wiki');
    }

    get indexPath(): string {
        return join(this.wikiRoot, 'INDEX.md');
    }

    get claimsPath(): string {
        return join(this.wikiRoot, 'claims.toml');
    }

    hasGitRepository(): boolean {
        return this.gitTopLevel() !== undefined;
    }

    isProjectRoot(): boolean {
        const repo = this.gitTopLevel();
        if (repo === undefined) return false;
        try {
            return realpathSync(repo) === this.workspace;
        } catch {
            return resolve(repo) === this.workspace;
        }
    }

    isInitialized(): boolean {
        if (!existsSync(this.claimsPath)) return false;
        const claims = readFileSync(this.claimsPath, 'utf8');
        if (/^\[claims\.[^\]]+\]\s*$/m.test(claims)) return true;
        if (!existsSync(this.indexPath)) return false;
        const index = readFileSync(this.indexPath, 'utf8');
        return index.trim().length > 0 && !index.includes('TODO');
    }

    repository(): ProjectWikiRepository | undefined {
        if (!existsSync(this.indexPath) && !existsSync(this.claimsPath)) return undefined;
        return readProjectWiki(this.workspace);
    }

    promptFragment(maxChars = 6000): string {
        const repository = this.repository();
        if (repository === undefined) {
            return [
                '## Project Wiki',
                '本项目尚未建立 Project Wiki。runtime 将在后台初始化骨架；',
                '回答涉及项目约定、结构或流程时，优先使用项目材料并等待 Wiki 沉淀。',
            ].join('\n');
        }
        const activeClaims = repository.claims
            .filter((claim) => claim.status !== 'retracted')
            .slice(0, 40)
            .map(
                (claim) =>
                    `- [${claim.id}${claim.status === 'active' ? '' : `/${claim.status}`}] ${claim.text}`,
            );
        const retractedTexts = repository.claims
            .filter((claim) => claim.status === 'retracted' && claim.text.trim().length > 0)
            .map((claim) => claim.text.trim());
        const index = repository.index
            .split(/\r?\n/)
            .filter((line) => !retractedTexts.some((text) => line.includes(text)))
            .join('\n');
        const text = [
            '## Project Wiki',
            index.trim(),
            ...(activeClaims.length > 0 ? ['', '### 已核验项目事实', ...activeClaims] : []),
        ]
            .filter((part) => part.length > 0)
            .join('\n\n');
        return text.length <= maxChars
            ? text
            : `${text.slice(0, maxChars).trimEnd()}\n\n（已截断）`;
    }

    async init(options: ProjectWikiInitOptions = {}): Promise<ProjectWikiInitResult> {
        const repo = this.gitTopLevel();
        if (repo === undefined) {
            throw new Error('Project Wiki 需要 Git 仓库');
        }
        const detection = detectProject(this.workspace, options.perModule === true);
        const created: string[] = [];
        const createdWiki: string[] = [];
        const createdAgents: string[] = [];
        const files: Array<[string, string]> = [
            ['wiki/INDEX.md', renderProjectWikiIndex(detection)],
            ['wiki/overview/architecture.md', PROJECT_WIKI_ARCHITECTURE_TEMPLATE],
            ['wiki/overview/conventions.md', PROJECT_WIKI_CONVENTIONS_TEMPLATE],
            ['wiki/overview/commands.md', projectWikiCommandsTemplate(detection.commands)],
            ['wiki/overview/deployment.md', projectWikiDeploymentTemplate(detection.deployHints)],
            ['wiki/overview/decisions/README.md', PROJECT_WIKI_DECISIONS_TEMPLATE],
            ['wiki/state/current.md', PROJECT_WIKI_CURRENT_TEMPLATE],
            ['wiki/state/lessons/README.md', PROJECT_WIKI_LESSONS_TEMPLATE],
            ['wiki/claims.toml', PROJECT_WIKI_CLAIMS_TEMPLATE],
        ];
        for (const [relativePath, content] of files) {
            if (writeIfMissing(join(this.workspace, relativePath), content)) {
                created.push(relativePath);
                createdWiki.push(relativePath);
            }
        }
        if (options.perModule === true) {
            for (const module of detection.modules) {
                const moduleRoot = join(this.workspace, module);
                const moduleFiles: Array<[string, string]> = [
                    [
                        'wiki/INDEX.md',
                        `# ${basename(moduleRoot)}\n\n> 模块 Wiki（上级：${relative(moduleRoot, this.indexPath)}）\n\n## 项目速查\nTODO\n`,
                    ],
                    ['wiki/claims.toml', PROJECT_WIKI_CLAIMS_TEMPLATE],
                    ['wiki/overview/architecture.md', `# ${module} 项目结构与关系\n\nTODO\n`],
                    ['wiki/state/current.md', PROJECT_WIKI_CURRENT_TEMPLATE],
                    ['wiki/state/lessons/README.md', PROJECT_WIKI_LESSONS_TEMPLATE],
                ];
                for (const [relativePath, content] of moduleFiles) {
                    const path = join(moduleRoot, relativePath);
                    if (writeIfMissing(path, content)) {
                        const repoPath = relative(repo, path).replace(/\\/g, '/');
                        created.push(repoPath);
                        createdWiki.push(repoPath);
                    }
                }
                const moduleAgents = updateMarkedBlock(
                    join(moduleRoot, 'AGENTS.md'),
                    PROJECT_WIKI_AGENTS_START,
                    PROJECT_WIKI_AGENTS_END,
                    moduleWikiAgentsBlock(),
                );
                if (moduleAgents)
                    createdAgents.push(relative(repo, moduleAgents).replace(/\\/g, '/'));
            }
        }
        const agents = updateMarkedBlock(
            join(this.workspace, 'AGENTS.md'),
            PROJECT_WIKI_AGENTS_START,
            PROJECT_WIKI_AGENTS_END,
            projectWikiAgentsBlock(),
        );
        if (agents) createdAgents.push(relative(repo, agents).replace(/\\/g, '/'));
        if (createdWiki.length > 0) {
            this.autoCommit(repo, createdWiki, 'wiki(init): scaffold knowledge base');
        }
        if (createdAgents.length > 0) {
            this.autoCommit(repo, createdAgents, 'wiki(init): add AGENTS.md pointers');
        }
        this.installHook(repo);
        return {
            root: this.workspace,
            created,
            projectType: detection.projectType,
            modules: detection.modules,
        };
    }

    async writeDoc(path: string, content: string): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const target = this.resolveWikiDocument(path);
        writeTextAtomic(target, content);
        return {
            ok: true,
            message: `已写入 ${relative(this.workspace, target).replace(/\\/g, '/')}`,
        };
    }

    async addClaim(input: ProjectWikiClaimInput): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const id = normalizeProjectWikiClaimId(input.id);
        const claims = this.loadClaims();
        if (claims.has(id)) throw new Error(`claim 已存在: ${id}`);
        const text = input.text.trim();
        if (text.length === 0) throw new Error('claim text 不能为空');
        const evidence = this.buildEvidence(repo, input.evidence);
        if (evidence.length === 0) throw new Error('claim 至少需要一个 evidence');
        const today = this.today();
        const claim: ProjectWikiClaim = {
            id,
            text,
            status: 'active',
            evidence,
            established: today,
            verified: today,
        };
        if (input.claimOid) claim.claimOid = computeProjectWikiClaimOid(claim);
        claims.set(id, claim);
        await this.saveClaims(repo, claims, `wiki(claim): add ${id}`);
        return { ok: true, message: `新增 claim ${id}`, commit: this.lastWikiCommit(repo) };
    }

    async updateClaim(input: ProjectWikiClaimUpdateInput): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const claims = this.loadClaims();
        const claim = claims.get(input.id);
        if (!claim) throw new Error(`claim 不存在: ${input.id}`);
        if (input.text !== undefined) {
            const text = input.text.trim();
            if (text.length === 0) throw new Error('claim text 不能为空');
            claim.text = text;
        }
        if (input.evidence !== undefined) {
            const evidence = this.buildEvidence(repo, input.evidence);
            if (evidence.length === 0) throw new Error('claim 至少需要一个 evidence');
            claim.evidence = evidence;
        } else {
            this.refreshClaimEvidence(repo, claim);
        }
        claim.status = 'active';
        claim.verified = this.today();
        if (input.claimOid) claim.claimOid = computeProjectWikiClaimOid(claim);
        await this.saveClaims(repo, claims, `wiki(claim): update ${input.id}`);
        return { ok: true, message: `更新 claim ${input.id}`, commit: this.lastWikiCommit(repo) };
    }

    async correctClaim(
        input: ProjectWikiClaimCorrectionInput,
    ): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const oldId = normalizeProjectWikiClaimId(input.oldId);
        const newId = normalizeProjectWikiClaimId(input.newId);
        if (oldId === newId) throw new Error('纠正事实必须使用新的 claim id，以保留替代关系');
        const reason = input.reason.trim();
        if (reason.length === 0) throw new Error('纠正原因不能为空');
        const claims = this.loadClaims();
        const oldClaim = claims.get(oldId);
        if (!oldClaim) throw new Error(`claim 不存在: ${oldId}`);
        if (claims.has(newId)) throw new Error(`claim 已存在: ${newId}`);
        const text = input.text.trim();
        if (text.length === 0) throw new Error('新事实不能为空');
        const evidence = this.buildEvidence(repo, input.evidence);
        if (evidence.length === 0) throw new Error('纠正后的事实至少需要一个 evidence');
        const today = this.today();
        oldClaim.status = 'retracted';
        oldClaim.retractedAt = today;
        oldClaim.retractedReason = reason;
        oldClaim.retractionKind = 'corrected';
        oldClaim.supersededBy = newId;
        const replacement: ProjectWikiClaim = {
            id: newId,
            text,
            status: 'active',
            evidence,
            established: today,
            verified: today,
            supersedes: oldId,
        };
        if (input.claimOid) replacement.claimOid = computeProjectWikiClaimOid(replacement);
        claims.set(newId, replacement);
        await this.saveClaims(repo, claims, `wiki(claim): correct ${oldId} -> ${newId}`);
        return {
            ok: true,
            message: `事实 ${oldId} 已由 ${newId} 替代并从后续上下文遗忘`,
            commit: this.lastWikiCommit(repo),
        };
    }

    async forgetClaim(input: ProjectWikiClaimForgetInput): Promise<ProjectWikiOperationResult> {
        return this.retractClaim(input.id, input.reason, 'forgotten');
    }

    async retractClaim(
        id: string,
        reason: string,
        kind: 'forgotten' | 'corrected' | 'obsolete' = 'obsolete',
    ): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const claims = this.loadClaims();
        const claim = claims.get(id);
        if (!claim) throw new Error(`claim 不存在: ${id}`);
        const reasonText = reason.trim();
        if (reasonText.length === 0) throw new Error('撤回或遗忘原因不能为空');
        claim.status = 'retracted';
        claim.retractedAt = this.today();
        claim.retractedReason = reasonText;
        claim.retractionKind = kind;
        await this.saveClaims(repo, claims, `wiki(claim): ${kind} ${id}`);
        return {
            ok: true,
            message: `claim ${id} 已撤回，后续上下文不再引用`,
            commit: this.lastWikiCommit(repo),
        };
    }

    async verifyClaims(
        options: { ids?: readonly string[]; all?: boolean; changed?: boolean } = {},
    ): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const claims = this.loadClaims();
        const ids = options.all
            ? [...claims.keys()]
            : options.changed
              ? (await this.updatePlan()).claims.map((claim) => claim.id)
              : [...(options.ids ?? [])];
        if (ids.length === 0) return { ok: true, message: '没有待核验 claim' };
        const targets = ids.map((id) => {
            const claim = claims.get(id);
            if (!claim) throw new Error(`claim 不存在: ${id}`);
            return claim;
        });
        for (const claim of targets) {
            if (claim.status === 'retracted') continue;
            this.ensureEvidenceFiles(repo, claim.evidence);
        }
        for (const claim of targets) {
            if (claim.status === 'retracted') continue;
            for (const evidence of claim.evidence) {
                evidence.oid = this.workingOid(repo, evidence.file) ?? evidence.oid;
            }
            claim.verified = this.today();
            if (claim.claimOid) claim.claimOid = computeProjectWikiClaimOid(claim);
        }
        await this.saveClaims(repo, claims, `wiki(claim): verify ${ids.join(',')}`);
        return {
            ok: true,
            message: `已核验 ${ids.length} 条 claim`,
            commit: this.lastWikiCommit(repo),
        };
    }

    async doctor(options: { claimId?: string } = {}): Promise<ProjectWikiDoctorReport> {
        const repo = this.requireRepo();
        const repository = readProjectWiki(this.workspace);
        if (!repository) throw new Error('Project Wiki 尚未初始化');
        const claims = repository.claims.filter(
            (claim) => options.claimId === undefined || claim.id === options.claimId,
        );
        if (options.claimId !== undefined && claims.length === 0) {
            throw new Error(`claim 不存在: ${options.claimId}`);
        }
        const findings: ProjectWikiVerificationFinding[] = [];
        for (const claim of claims) {
            if (claim.status === 'retracted') continue;
            for (const evidence of claim.evidence) {
                if (evidence.status === 'missing') {
                    findings.push({
                        level: 'MISSING',
                        claimId: claim.id,
                        message: `${evidence.file} 不存在`,
                    });
                } else if (evidence.status === 'stale') {
                    findings.push({
                        level: 'STALE',
                        claimId: claim.id,
                        message: `${evidence.file} oid 已变化`,
                    });
                }
            }
        }
        const warnings = lintWikiDocs(this.workspace, repository);
        const active = claims.filter((claim) => claim.status === 'active').length;
        const stale = claims.filter((claim) => claim.status === 'stale').length;
        const missing = claims.filter((claim) => claim.status === 'missing').length;
        const retracted = claims.filter((claim) => claim.status === 'retracted').length;
        void repo;
        return {
            root: repository.root,
            claims: claims.length,
            active,
            stale,
            missing,
            retracted,
            findings,
            warnings,
        };
    }

    async doctorStaged(): Promise<
        ProjectWikiOperationResult & { findings: ProjectWikiVerificationFinding[] }
    > {
        const repo = this.requireRepo();
        const staged = new Set(
            this.nulFiles(['diff', '--cached', '--name-only', '--no-renames', '-z'], repo),
        );
        if (staged.size === 0) {
            return { ok: true, message: '暂存区为空，门禁通过', findings: [] };
        }
        const index = this.indexOids(repo);
        const claims = this.loadClaims();
        const findings: ProjectWikiVerificationFinding[] = [];
        for (const claim of claims.values()) {
            if (claim.status === 'retracted') continue;
            for (const evidence of claim.evidence) {
                if (!staged.has(evidence.file)) continue;
                const actual = index.get(evidence.file);
                if (actual === undefined) {
                    findings.push({
                        level: 'MISSING',
                        claimId: claim.id,
                        message: `${evidence.file} 已从 index 删除`,
                    });
                } else if (actual !== evidence.oid) {
                    findings.push({
                        level: 'STALE',
                        claimId: claim.id,
                        message: `${evidence.file} 的 staged oid 与 claim 不一致`,
                    });
                }
            }
        }
        return {
            ok: findings.length === 0,
            message:
                findings.length === 0 ? '提交门禁通过' : `提交门禁发现 ${findings.length} 条不一致`,
            findings,
        };
    }

    async doctorGitStatus(): Promise<ProjectWikiCommandResult> {
        const repo = this.requireRepo();
        const changed = new Set(
            this.statusFiles(repo).filter(
                (file) =>
                    file !== relative(repo, this.wikiRoot) &&
                    !file.startsWith(`${relative(repo, this.wikiRoot)}/`),
            ),
        );
        const claims = [...this.loadClaims().values()].filter(
            (claim) =>
                claim.status !== 'retracted' &&
                claim.evidence.some((evidence) => changed.has(evidence.file)),
        );
        return {
            ok: true,
            content:
                claims.length === 0
                    ? '工作区变更未触及任何 claim'
                    : `${claims.length} 条 claim 可能需要核验: ${claims
                          .map((claim) => claim.id)
                          .join(', ')}`,
            data: claims.map((claim) => claim.id),
        };
    }

    async doctorAll(): Promise<ProjectWikiDoctorReport[]> {
        const repo = this.requireRepo();
        const roots = this.allWikiRoots(repo);
        const reports: ProjectWikiDoctorReport[] = [];
        for (const root of roots) {
            const service =
                resolve(root) === this.workspace
                    ? this
                    : new ProjectWikiService({ workspace: root, now: this.now });
            reports.push(await service.doctor());
        }
        return reports;
    }

    async updatePlan(): Promise<ProjectWikiUpdatePlan> {
        const repo = this.requireRepo();
        const relWiki = relative(repo, this.wikiRoot).replace(/\\/g, '/');
        const checkpoint = this.lastSemanticCheckpoint(repo, relWiki);
        const files = new Set<string>();
        if (checkpoint) {
            const out = this.gitSync(['diff', '--name-only', checkpoint, 'HEAD'], repo);
            for (const file of out.split(/\r?\n/)) if (file) files.add(file);
        }
        for (const file of this.statusFiles(repo)) files.add(file);
        for (const file of [...files]) {
            if (file === relWiki || file.startsWith(`${relWiki}/`)) files.delete(file);
        }
        const deletedFiles = new Set<string>();
        for (const file of files) {
            if (existsSync(join(repo, file))) continue;
            deletedFiles.add(file);
            files.delete(file);
        }
        const claims = readProjectWiki(this.workspace)?.claims ?? [];
        const byFile = new Map<string, string[]>();
        for (const claim of claims) {
            if (claim.status === 'retracted') continue;
            for (const evidence of claim.evidence) {
                const ids = byFile.get(evidence.file) ?? [];
                ids.push(claim.id);
                byFile.set(evidence.file, ids);
            }
        }
        const hitIds = new Set<string>();
        for (const file of files) {
            for (const id of byFile.get(file) ?? []) hitIds.add(id);
        }
        const findings = claims.filter(
            (claim) =>
                claim.status !== 'retracted' &&
                (claim.status === 'stale' || claim.status === 'missing'),
        );
        for (const claim of findings) hitIds.add(claim.id);
        const rows = [...hitIds].sort().map((id) => {
            const claim = claims.find((candidate) => candidate.id === id);
            if (!claim) throw new Error(`claim 不存在: ${id}`);
            return {
                id,
                text: claim.text,
                evidence: claim.evidence.map((entry) => ({
                    file: entry.file,
                    status:
                        entry.status === 'missing' || entry.status === 'stale'
                            ? entry.status
                            : ('active' as const),
                })),
                detail: claim.evidence.some((entry) => entry.status === 'missing')
                    ? `MISSING ${claim.evidence
                          .filter((entry) => entry.status === 'missing')
                          .map((entry) => entry.file)
                          .join(', ')}`
                    : claim.evidence.some((entry) => entry.status === 'stale')
                      ? `STALE ${claim.evidence
                            .filter((entry) => entry.status === 'stale')
                            .map((entry) => entry.file)
                            .join(', ')}`
                      : 'oid 无变化（提交历史变化）',
            };
        });
        return {
            checkpoint: checkpoint ? this.gitSync(['rev-parse', checkpoint], repo) : null,
            changed_files: [...files].sort(),
            deleted_files: [...deletedFiles].sort(),
            claims: rows,
            no_changes: files.size === 0 && deletedFiles.size === 0 && rows.length === 0,
            needs_semantic_update: findings.length > 0,
        };
    }

    async record(input: ProjectWikiActivityInput): Promise<ProjectWikiActivity> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const current = join(this.wikiRoot, 'state', 'current.md');
        let text = existsSync(current)
            ? readFileSync(current, 'utf8')
            : PROJECT_WIKI_CURRENT_TEMPLATE;
        const match = text.match(
            new RegExp(`${escapeRegExp(ACTIVITY_START)}([\\s\\S]*?)${escapeRegExp(ACTIVITY_END)}`),
        );
        const existing = match
            ? (match[1] ?? '')
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter((line) => line.startsWith('- '))
            : [];
        const at = formatLocalTimestamp(this.now());
        const statusLabel = activityStatusLabel(input.status);
        const activity: ProjectWikiActivity = {
            ...input,
            at,
            statusLabel,
        };
        const line =
            `- ${at} | ${statusLabel} | ${cleanActivity(input.input, 100)}` +
            (input.summary?.trim() ? ` | ${cleanActivity(input.summary, 180)}` : '');
        const lines = [...existing, line].slice(-20);
        const block = `${ACTIVITY_START}\n${lines.join('\n')}${lines.length > 0 ? '\n' : ''}${ACTIVITY_END}`;
        text =
            match !== null
                ? text.slice(0, match.index) +
                  block +
                  text.slice((match.index ?? 0) + match[0].length)
                : `${text.trimEnd()}\n\n## 会话活动\n${block}\n`;
        writeTextAtomic(current, text);
        const currentRelative = relative(repo, current).replace(/\\/g, '/');
        this.autoCommit(repo, [currentRelative], ACTIVITY_COMMIT_SUBJECT);
        return activity;
    }

    async sessionEnd(input: ProjectWikiActivityInput): Promise<ProjectWikiSessionEndResult> {
        const plan = await this.updatePlan();
        const activity = await this.record(input);
        return { ...plan, activity };
    }

    async checkpoint(options: { force?: boolean } = {}): Promise<ProjectWikiOperationResult> {
        this.assertInitialized();
        const repo = this.requireRepo();
        const roots = this.allWikiRoots(repo);
        const activeRoots = roots.length > 0 ? roots : [this.workspace];
        const findings: ProjectWikiVerificationFinding[] = [];
        for (const root of activeRoots) {
            const service =
                resolve(root) === this.workspace
                    ? this
                    : new ProjectWikiService({ workspace: root, now: this.now });
            const report = await service.doctor();
            findings.push(...report.findings);
        }
        if (findings.length > 0 && options.force !== true) {
            throw new Error(
                `存在未修复漂移，拒绝 checkpoint：${findings
                    .map((finding) => `${finding.claimId} ${finding.message}`)
                    .join('; ')}`,
            );
        }
        for (const root of activeRoots) {
            refreshProjectWikiRecent(root, repo);
        }
        const prefixes = activeRoots.map((root) =>
            relative(repo, join(root, 'wiki')).replace(/\\/g, '/'),
        );
        this.autoCommit(repo, prefixes, 'wiki(checkpoint): sync state & index');
        for (const root of activeRoots) {
            refreshProjectWikiRecent(root, repo);
        }
        this.gitSync(['add', '--', ...prefixes], repo);
        this.gitSync(['commit', '--amend', '--no-edit', '--', ...prefixes], repo);
        const commit = this.lastWikiCommit(repo);
        return { ok: true, message: 'checkpoint 完成', ...(commit ? { commit } : {}) };
    }

    async runCommand(argv: readonly string[]): Promise<ProjectWikiCommandResult> {
        const [command, subcommand] = argv;
        if (command === 'root') {
            return { ok: true, content: this.workspace };
        }
        if (command === 'init') {
            const result = await this.init({ perModule: argv.includes('--per-module') });
            return {
                ok: true,
                content: `init 完成：新建 ${result.created.length} 项`,
                data: result,
            };
        }
        if (command === 'doctor') {
            if (argv.includes('--staged')) {
                const result = await this.doctorStaged();
                return {
                    ok: result.ok,
                    content: [
                        result.message,
                        ...result.findings.map(
                            (finding) => `${finding.level} ${finding.claimId} ${finding.message}`,
                        ),
                    ].join('\n'),
                    data: result,
                };
            }
            if (argv.includes('--git-status')) {
                const result = await this.doctorGitStatus();
                return { ok: result.ok, content: result.content, data: result.data };
            }
            if (argv.includes('--all')) {
                const reports = await this.doctorAll();
                return {
                    ok: reports.every((report) => report.missing === 0),
                    content: reports
                        .map(
                            (report) =>
                                `[${report.root}] ${report.claims} claims, ${report.stale} stale, ${report.missing} missing`,
                        )
                        .join('\n'),
                    data: reports,
                };
            }
            const claimIndex = argv.indexOf('--claim');
            const report = await this.doctor(
                claimIndex >= 0 ? { claimId: argv[claimIndex + 1] } : {},
            );
            const lines = [
                `[Project Wiki] root=${report.root}`,
                ...report.findings.map(
                    (finding) => `${finding.level} ${finding.claimId} ${finding.message}`,
                ),
                ...report.warnings.map((warning) => `WARN ${warning}`),
                `summary: ${report.claims} claims, ${report.stale} stale, ${report.missing} missing, ${report.warnings.length} warn`,
            ];
            return {
                ok: report.missing === 0,
                content: lines.join('\n'),
                data: report,
            };
        }
        if (command === 'update') {
            const plan = await this.updatePlan();
            return {
                ok: true,
                content: JSON.stringify(plan),
                data: plan,
            };
        }
        if (command === 'record') {
            const activity = await this.record({
                input: option(argv, '--input') ?? '',
                status:
                    (option(argv, '--status') as 'success' | 'failed' | 'aborted' | undefined) ??
                    'success',
                summary: option(argv, '--summary') ?? '',
            });
            return { ok: true, content: `已记录会话活动: ${activity.input}`, data: activity };
        }
        if (command === 'session-end') {
            const result = await this.sessionEnd({
                input: option(argv, '--input') ?? '',
                status:
                    (option(argv, '--status') as 'success' | 'failed' | 'aborted' | undefined) ??
                    'success',
                summary: option(argv, '--summary') ?? '',
            });
            return { ok: true, content: JSON.stringify(result), data: result };
        }
        if (command === 'checkpoint') {
            const result = await this.checkpoint({ force: argv.includes('--force') });
            return { ok: result.ok, content: result.message, data: result };
        }
        if (command === 'claim') {
            if (subcommand === 'add') {
                const result = await this.addClaim({
                    id: option(argv, '--id') ?? '',
                    text: option(argv, '--text') ?? '',
                    evidence: options(argv, '--ev').map((file) => ({ file })),
                    claimOid: argv.includes('--claim-oid'),
                });
                return { ok: result.ok, content: result.message, data: result };
            }
            if (subcommand === 'verify') {
                const ids = option(argv, '--ids')?.split(',').filter(Boolean);
                const id = option(argv, '--id');
                const result = await this.verifyClaims({
                    ...(ids ? { ids } : {}),
                    ...(id ? { ids: [id] } : {}),
                    all: argv.includes('--all'),
                    changed: argv.includes('--changed'),
                });
                return { ok: result.ok, content: result.message, data: result };
            }
            if (subcommand === 'update') {
                const result = await this.updateClaim({
                    id: option(argv, '--id') ?? '',
                    ...(option(argv, '--text') ? { text: option(argv, '--text') } : {}),
                    ...(options(argv, '--ev').length > 0
                        ? {
                              evidence: options(argv, '--ev').map((file) => ({ file })),
                          }
                        : {}),
                    claimOid: argv.includes('--claim-oid'),
                });
                return { ok: result.ok, content: result.message, data: result };
            }
            if (subcommand === 'retract') {
                const result = await this.retractClaim(
                    option(argv, '--id') ?? '',
                    option(argv, '--reason') ?? '',
                    'obsolete',
                );
                return { ok: result.ok, content: result.message, data: result };
            }
            if (subcommand === 'forget') {
                const result = await this.forgetClaim({
                    id: option(argv, '--id') ?? '',
                    reason: option(argv, '--reason') ?? '',
                });
                return { ok: result.ok, content: result.message, data: result };
            }
            if (subcommand === 'correct') {
                const result = await this.correctClaim({
                    oldId: option(argv, '--old-id') ?? option(argv, '--id') ?? '',
                    newId: option(argv, '--new-id') ?? '',
                    text: option(argv, '--text') ?? '',
                    evidence: options(argv, '--ev').map((file) => ({ file })),
                    reason: option(argv, '--reason') ?? '',
                    claimOid: argv.includes('--claim-oid'),
                });
                return { ok: result.ok, content: result.message, data: result };
            }
        }
        throw new Error(`不支持的 Project Wiki 命令: ${argv.join(' ')}`);
    }

    checkpointCompletedSince(since: number): boolean {
        const repo = this.requireRepo();
        const out = this.gitSync(
            ['log', '-1', '--format=%ct%x00%s', '--', relative(repo, this.wikiRoot)],
            repo,
            false,
        );
        const [seconds = '0', subject = ''] = out.trim().split('\0');
        return subject.startsWith('wiki(checkpoint):') && Number(seconds) * 1000 >= since - 2000;
    }

    private assertInitialized(): void {
        if (!existsSync(this.claimsPath)) throw new Error('Project Wiki 尚未初始化');
    }

    private requireRepo(): string {
        const repo = this.gitTopLevel();
        if (!repo) throw new Error('Project Wiki 需要 Git 仓库');
        return repo;
    }

    private gitTopLevel(): string | undefined {
        try {
            return execFileSync('git', ['rev-parse', '--show-toplevel'], {
                cwd: this.workspace,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        } catch {
            return undefined;
        }
    }

    private gitSync(args: readonly string[], cwd: string, check = true): string {
        try {
            return execFileSync('git', [...args], {
                cwd,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            if (!check) return '';
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`git ${args.join(' ')} 失败: ${message}`);
        }
    }

    private autoCommit(repo: string, paths: readonly string[], message: string): void {
        const targets = [...new Set(paths.filter(Boolean))];
        if (targets.length === 0) return;
        this.gitSync(['add', '--', ...targets], repo);
        try {
            this.gitSync(['commit', '-m', message, '--', ...targets], repo);
        } catch (error) {
            const messageText = error instanceof Error ? error.message.toLowerCase() : '';
            if (!messageText.includes('nothing to commit') && !messageText.includes('no changes')) {
                throw error;
            }
        }
    }

    private lastWikiCommit(repo: string): string | undefined {
        const value = this.gitSync(
            ['log', '-1', '--format=%h %s', '--', relative(repo, this.wikiRoot)],
            repo,
            false,
        ).trim();
        return value || undefined;
    }

    private lastSemanticCheckpoint(repo: string, relWiki: string): string {
        const out = this.gitSync(['log', '-50', '--format=%H%x00%s', '--', relWiki], repo, false);
        for (const line of out.split(/\r?\n/)) {
            const [commit, subject = ''] = line.split('\0');
            if (commit && subject !== ACTIVITY_COMMIT_SUBJECT) return commit;
        }
        return '';
    }

    private statusFiles(repo: string): string[] {
        const output = this.gitSync(['status', '--porcelain=v1', '-z'], repo, false);
        const records = output.split('\0').filter(Boolean);
        const files: string[] = [];
        for (let index = 0; index < records.length; index += 1) {
            const record = records[index] ?? '';
            if (record.length < 4) continue;
            const state = record.slice(0, 2);
            files.push(record.slice(3));
            if (state.includes('R') || state.includes('C')) {
                const next = records[index + 1];
                if (next) files.push(next);
                index += 1;
            }
        }
        return files;
    }

    private nulFiles(args: readonly string[], repo: string): string[] {
        return this.gitSync(args, repo, false).split('\0').filter(Boolean);
    }

    private indexOids(repo: string): Map<string, string> {
        const output = this.gitSync(['ls-files', '-s', '-z'], repo, false);
        const result = new Map<string, string>();
        for (const record of output.split('\0')) {
            if (!record) continue;
            const [meta, file] = record.split('\t', 2);
            const [, oid, stage] = (meta ?? '').split(' ');
            if (file && oid && stage === '0') result.set(file, oid);
        }
        return result;
    }

    private loadClaims(): Map<string, ProjectWikiClaim> {
        return parseProjectWikiClaims(readFileSync(this.claimsPath, 'utf8'));
    }

    private async saveClaims(
        repo: string,
        claims: ReadonlyMap<string, ProjectWikiClaim>,
        message: string,
    ): Promise<void> {
        writeTextAtomic(this.claimsPath, serializeProjectWikiClaims(claims));
        const relWiki = relative(repo, this.wikiRoot).replace(/\\/g, '/');
        this.autoCommit(repo, [relWiki], message);
    }

    private buildEvidence(
        repo: string,
        inputs: readonly ProjectWikiEvidenceInput[],
    ): ProjectWikiClaim['evidence'] {
        const evidence: ProjectWikiClaim['evidence'] = [];
        for (const input of normalizeEvidenceInputs(inputs)) {
            const file = this.normalizeRepoPath(repo, input.file);
            const oid = this.workingOid(repo, file);
            if (!oid) throw new Error(`evidence 文件不存在: ${file}`);
            evidence.push({ file, oid, ...(input.hint ? { hint: input.hint } : {}) });
        }
        return evidence;
    }

    private normalizeRepoPath(repo: string, file: string): string {
        const absolute = isAbsolute(file) ? file : resolve(this.workspace, file);
        const rel = relative(repo, absolute).replace(/\\/g, '/');
        if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
            throw new Error(`evidence 不在仓库内: ${file}`);
        }
        return rel;
    }

    private workingOid(repo: string, file: string): string | undefined {
        try {
            return this.gitSync(['hash-object', '--', file], repo).trim() || undefined;
        } catch {
            return undefined;
        }
    }

    private refreshClaimEvidence(repo: string, claim: ProjectWikiClaim): void {
        this.ensureEvidenceFiles(repo, claim.evidence);
        for (const evidence of claim.evidence) {
            evidence.oid = this.workingOid(repo, evidence.file) ?? evidence.oid;
        }
    }

    private ensureEvidenceFiles(repo: string, evidence: ProjectWikiClaim['evidence']): void {
        const missing = evidence.filter((entry) => this.workingOid(repo, entry.file) === undefined);
        if (missing.length > 0) {
            throw new Error(`evidence 缺失: ${missing.map((entry) => entry.file).join(', ')}`);
        }
    }

    private resolveWikiDocument(path: string): string {
        const clean = path.trim();
        if (!clean || isAbsolute(clean) || clean.includes('\0')) {
            throw new Error('Wiki 文档路径必须是 wiki/ 下相对路径');
        }
        const wikiRoot = realpathSync(this.wikiRoot);
        const target = resolve(wikiRoot, clean);
        const rel = relative(wikiRoot, target);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error('Wiki 文档路径越出 wiki/');
        }
        if (!target.endsWith('.md')) throw new Error('只允许写 Wiki Markdown');
        if (basename(target) === 'claims.toml') {
            throw new Error('claims.toml 只能通过 Project Wiki claim API 修改');
        }
        return target;
    }

    private installHook(repo: string): void {
        const configured = this.gitSync(['config', '--get', 'core.hooksPath'], repo, false).trim();
        const husky = join(this.workspace, '.husky', 'pre-commit');
        let hook: string;
        if (existsSync(husky)) {
            hook = husky;
        } else if (configured) {
            hook = isAbsolute(configured)
                ? join(configured, 'pre-commit')
                : join(this.workspace, configured, 'pre-commit');
        } else {
            const gitDir = this.gitSync(['rev-parse', '--git-dir'], repo).trim();
            hook = join(
                isAbsolute(gitDir) ? gitDir : join(this.workspace, gitDir),
                'hooks',
                'pre-commit',
            );
        }
        const cli = fileURLToPath(new URL('../../dist/wiki/project-wiki-cli.js', import.meta.url));
        if (!existsSync(cli)) return;
        const line = `${HOOK_MARK}\n"${process.execPath}" "${cli}" doctor --staged`;
        const current = existsSync(hook) ? readFileSync(hook, 'utf8') : '#!/bin/sh\n';
        const block = `${HOOK_MARK}\n"${process.execPath}" "${cli}" doctor --staged`;
        const marker = new RegExp(`${escapeRegExp(HOOK_MARK)}\\n[^\\n]*`);
        const next = marker.test(current)
            ? current.replace(marker, block)
            : `${current.trimEnd()}\n${line}\n`;
        writeTextAtomic(hook, next);
        try {
            execFileSync('chmod', ['755', hook]);
        } catch {
            // chmod failure is non-fatal on platforms without POSIX modes.
        }
    }

    private allWikiRoots(repo: string): string[] {
        const out = this.gitSync(
            [
                'ls-files',
                '--cached',
                '--others',
                '--exclude-standard',
                '-z',
                '--',
                '*/wiki/claims.toml',
                'wiki/claims.toml',
            ],
            repo,
            false,
        );
        return [
            ...new Set(
                out
                    .split('\0')
                    .filter(Boolean)
                    .map((file) => dirname(dirname(join(repo, file)))),
            ),
        ].sort();
    }

    private today(): string {
        return formatIsoDate(this.now());
    }
}

export function readProjectWiki(workspace: string): ProjectWikiRepository | undefined {
    const root = findProjectWikiRoot(resolve(workspace));
    if (!root) return undefined;
    const wikiRoot = join(root, 'wiki');
    const repo = gitTopLevel(root) ?? root;
    const claimsPath = join(wikiRoot, 'claims.toml');
    const parsed = existsSync(claimsPath)
        ? parseProjectWikiClaims(readFileSync(claimsPath, 'utf8'))
        : new Map<string, ProjectWikiClaim>();
    const oidCache = new Map<string, string | undefined>();
    const claims = [...parsed.values()].map((claim) =>
        withResolvedEvidence(claim, (file) => {
            if (!oidCache.has(file)) oidCache.set(file, workingOidAt(repo, file));
            return oidCache.get(file);
        }),
    );
    const docs = readProjectWikiDocs(wikiRoot);
    const indexPath = join(wikiRoot, 'INDEX.md');
    const index = docs.find((doc) => doc.path === 'INDEX.md')?.content ?? '';
    const summary = {
        documents: docs.length,
        claims: claims.length,
        active: claims.filter((claim) => claim.status === 'active').length,
        stale: claims.filter((claim) => claim.status === 'stale').length,
        missing: claims.filter((claim) => claim.status === 'missing').length,
        retracted: claims.filter((claim) => claim.status === 'retracted').length,
        forgotten: claims.filter(
            (claim) => claim.status === 'retracted' && claim.retractionKind === 'forgotten',
        ).length,
    };
    return {
        root,
        wikiRoot,
        indexPath,
        index,
        docs,
        claims,
        summary,
        ...(latestProjectWikiCommit(root) ?? {}),
    };
}

export function findProjectWikiRoot(start: string): string | undefined {
    let current = start;
    while (true) {
        if (
            existsSync(join(current, 'wiki', 'claims.toml')) ||
            existsSync(join(current, 'wiki', 'INDEX.md'))
        ) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
}

function readProjectWikiDocs(wikiRoot: string): ProjectWikiDoc[] {
    const docs: ProjectWikiDoc[] = [];
    walkWikiDocs(wikiRoot, wikiRoot, docs);
    docs.sort((left, right) => {
        const rank = docGroupRank(left.group) - docGroupRank(right.group);
        return rank === 0 ? left.path.localeCompare(right.path) : rank;
    });
    return docs.slice(0, MAX_DOCS);
}

function walkWikiDocs(wikiRoot: string, directory: string, docs: ProjectWikiDoc[]): void {
    if (docs.length >= MAX_DOCS) return;
    let entries: Dirent[];
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (docs.length >= MAX_DOCS || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            walkWikiDocs(wikiRoot, path, docs);
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        try {
            if (statSync(path).size > MAX_DOC_BYTES) continue;
            const content = readFileSync(path, 'utf8');
            const relativePath = relative(wikiRoot, path).replace(/\\/g, '/');
            docs.push({
                path: relativePath,
                title: documentTitle(content, relativePath),
                group: documentGroup(relativePath),
                content,
            });
        } catch {
            // Ignore one unreadable document and keep the rest of the wiki.
        }
    }
}

function documentTitle(content: string, path: string): string {
    return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path, '.md');
}

function documentGroup(path: string): ProjectWikiDoc['group'] {
    if (path === 'INDEX.md') return 'index';
    if (path.startsWith('overview/decisions/')) return 'decisions';
    if (path.startsWith('state/lessons/')) return 'lessons';
    if (path.startsWith('overview/')) return 'overview';
    if (path.startsWith('state/')) return 'state';
    return 'other';
}

function docGroupRank(group: ProjectWikiDoc['group']): number {
    return {
        index: 0,
        overview: 1,
        state: 2,
        decisions: 3,
        lessons: 4,
        other: 5,
    }[group];
}

function gitTopLevel(root: string): string | undefined {
    try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return undefined;
    }
}

function workingOidAt(repo: string, file: string): string | undefined {
    try {
        return execFileSync('git', ['hash-object', '--', file], {
            cwd: repo,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return undefined;
    }
}

function latestProjectWikiCommit(root: string): { latestCommit?: ProjectWikiCommit } {
    try {
        const raw = execFileSync('git', ['log', '-1', '--format=%h%x00%cI%x00%s', '--', 'wiki'], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const [hash, committedAt, subject] = raw.split('\0');
        if (!hash || !committedAt || !subject) return {};
        return { latestCommit: { hash, committedAt, subject } };
    } catch {
        return {};
    }
}

function lintWikiDocs(workspace: string, repository: ProjectWikiRepository): string[] {
    const warnings: string[] = [];
    for (const doc of repository.docs) {
        const lines = doc.content.split(/\r?\n/).length;
        if (lines > LINE_WARN) warnings.push(`${doc.path} 共 ${lines} 行 (> ${LINE_WARN})`);
    }
    const links = repository.index.matchAll(/\]\(([^)#]+?\.md)\)/g);
    for (const match of links) {
        const target = resolve(join(workspace, 'wiki'), match[1] ?? '');
        if (!existsSync(target)) warnings.push(`INDEX 链接不可达: ${match[1]}`);
    }
    return warnings;
}

function refreshProjectWikiRecent(root: string, repo: string): void {
    const indexPath = join(root, 'wiki', 'INDEX.md');
    if (!existsSync(indexPath)) return;
    const log = execFileSync(
        'git',
        [
            'log',
            '-8',
            '--format=- %h %ad %s',
            '--date=format:%Y-%m-%d %H:%M:%S',
            '--',
            relative(repo, join(root, 'wiki')),
        ],
        { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const block = `<!-- recent:start -->\n${log}\n<!-- recent:end -->`;
    const text = readFileSync(indexPath, 'utf8');
    const next = text.includes('<!-- recent:start -->')
        ? text.replace(/<!-- recent:start -->[\s\S]*?<!-- recent:end -->/, block)
        : `${text.trimEnd()}\n\n## 最近更新\n${block}\n`;
    writeTextAtomic(indexPath, next);
}

function updateMarkedBlock(
    path: string,
    start: string,
    end: string,
    block: string,
): string | undefined {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current.includes(start)) {
        const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
        const next = current.replace(pattern, block);
        if (next === current) return undefined;
        writeTextAtomic(path, next);
        return path;
    }
    writeTextAtomic(path, `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`);
    return path;
}

function writeIfMissing(path: string, content: string): boolean {
    if (existsSync(path)) return false;
    writeTextAtomic(path, content);
    return true;
}

function writeTextAtomic(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, path);
}

function option(argv: readonly string[], name: string): string | undefined {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
}

function options(argv: readonly string[], name: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1] ?? '');
    }
    return values;
}

function activityStatusLabel(status: ProjectWikiActivityInput['status']): string {
    return status === 'success' ? '成功' : status === 'failed' ? '失败' : '中止';
}

function cleanActivity(value: string, limit: number): string {
    return value.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|').slice(0, limit);
}

function formatLocalTimestamp(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
        date.getHours(),
    )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatIsoDate(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
