import { isAbsolute, relative, resolve } from 'node:path';
import type { ProjectBlackboardService } from '../blackboard/index.js';
import type { ToolConfig } from '../config.js';
import type { ProjectWikiService, WikiService } from '../wiki/index.js';

export function blackboardToolConfigs(
    blackboard: ProjectBlackboardService,
    projectId: string,
    workspace: string,
): ToolConfig[] {
    return [
        {
            name: 'blackboard.read',
            description:
                'Read the current project blackboard. Use summary/architecture/status/issues/decisions for the relevant section instead of rescanning the entire repository.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['summary', 'architecture', 'status', 'issues', 'decisions', 'all'],
                    },
                },
            },
            minPermission: 'read-only',
            sideEffects: [],
            impl: async (args) => {
                const board = await blackboard.ensure(projectId, workspace);
                const section =
                    args.section === 'summary' ||
                    args.section === 'architecture' ||
                    args.section === 'status' ||
                    args.section === 'issues' ||
                    args.section === 'decisions'
                        ? args.section
                        : 'all';
                return {
                    ok: true,
                    content: blackboard.read(board, section),
                };
            },
        },
    ];
}

export function projectWikiToolConfig(projectWiki: ProjectWikiService): ToolConfig {
    return {
        name: 'project_wiki',
        description:
            'Maintain the Git-backed Project Wiki. Use structured actions; claims and oids are computed by runtime. Corrected facts must use claim_correct and removed facts use claim_forget.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'write_doc',
                        'claim_add',
                        'claim_update',
                        'claim_correct',
                        'claim_forget',
                        'claim_verify',
                        'doctor',
                        'update_plan',
                        'checkpoint',
                    ],
                },
                path: {
                    type: 'string',
                    description: 'Wiki-relative Markdown path for write_doc.',
                },
                content: {
                    type: 'string',
                    description: 'Complete Markdown content for write_doc.',
                },
                id: {
                    type: 'string',
                    description: 'Claim id for claim_update / claim_correct / claim_forget.',
                },
                newId: {
                    type: 'string',
                    description: 'Replacement claim id for claim_correct.',
                },
                text: {
                    type: 'string',
                    description: 'Claim text for claim_add / claim_update / claim_correct.',
                },
                reason: {
                    type: 'string',
                    description: 'Required audit reason for claim_correct / claim_forget.',
                },
                evidence: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Repository-relative evidence files.',
                },
                ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Claim ids for batched verification.',
                },
                all: {
                    type: 'boolean',
                    description: 'Verify all active claims.',
                },
                changed: {
                    type: 'boolean',
                    description: 'Verify claims affected by the current incremental plan.',
                },
            },
            required: ['action'],
        },
        minPermission: 'draft',
        sideEffects: ['fs'],
        impl: async (args) => {
            try {
                const action = typeof args.action === 'string' ? args.action : '';
                const evidence = Array.isArray(args.evidence)
                    ? args.evidence.filter(
                          (item): item is string => typeof item === 'string' && item.length > 0,
                      )
                    : [];
                const ids = Array.isArray(args.ids)
                    ? args.ids.filter((item): item is string => typeof item === 'string')
                    : [];
                if (action === 'write_doc') {
                    if (typeof args.path !== 'string' || typeof args.content !== 'string') {
                        return { ok: false, error: 'write_doc 需要 path 和 content' };
                    }
                    const result = await projectWiki.writeDoc(args.path, args.content);
                    return { ok: result.ok, content: result.message };
                }
                if (action === 'claim_add') {
                    const result = await projectWiki.addClaim({
                        id: typeof args.id === 'string' ? args.id : '',
                        text: typeof args.text === 'string' ? args.text : '',
                        evidence: evidence.map((file) => ({ file })),
                    });
                    return { ok: result.ok, content: result.message };
                }
                if (action === 'claim_update') {
                    const result = await projectWiki.updateClaim({
                        id: typeof args.id === 'string' ? args.id : '',
                        ...(typeof args.text === 'string' ? { text: args.text } : {}),
                        ...(evidence.length > 0
                            ? { evidence: evidence.map((file) => ({ file })) }
                            : {}),
                    });
                    return { ok: result.ok, content: result.message };
                }
                if (action === 'claim_correct') {
                    const result = await projectWiki.correctClaim({
                        oldId: typeof args.id === 'string' ? args.id : '',
                        newId: typeof args.newId === 'string' ? args.newId : '',
                        text: typeof args.text === 'string' ? args.text : '',
                        evidence: evidence.map((file) => ({ file })),
                        reason: typeof args.reason === 'string' ? args.reason : '',
                    });
                    return { ok: result.ok, content: result.message };
                }
                if (action === 'claim_forget') {
                    const result = await projectWiki.forgetClaim({
                        id: typeof args.id === 'string' ? args.id : '',
                        reason: typeof args.reason === 'string' ? args.reason : '',
                    });
                    return { ok: result.ok, content: result.message };
                }
                if (action === 'claim_verify') {
                    const result = await projectWiki.verifyClaims({
                        ...(ids.length > 0 ? { ids } : {}),
                        all: args.all === true,
                        changed: args.changed === true,
                    });
                    return { ok: result.ok, content: result.message };
                }
                if (action === 'doctor') {
                    const report = await projectWiki.doctor();
                    return { ok: report.missing === 0, content: JSON.stringify(report) };
                }
                if (action === 'update_plan') {
                    const plan = await projectWiki.updatePlan();
                    return { ok: true, content: JSON.stringify(plan) };
                }
                if (action === 'checkpoint') {
                    const result = await projectWiki.checkpoint();
                    return { ok: result.ok, content: result.message };
                }
                return { ok: false, error: `不支持的 Project Wiki action: ${action}` };
            } catch (error) {
                return {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        },
    };
}

export function assertInsideWorkspace(workspaceRoot: string, path: string): void {
    const root = resolve(workspaceRoot);
    const target = resolve(isAbsolute(path) ? path : resolve(root, path));
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`路径越出工作区：${path}`);
    }
}

/**
 * 项目 wiki 的内置工具面（设计 §9）：
 * - wiki.read：读快照/变更日志（只读，免审批）；
 * - wiki.update：替换快照 / 追加条目（写能力，走既有判权与审批）。
 */
export function wikiToolConfigs(wiki: WikiService): ToolConfig[] {
    return [
        {
            name: 'wiki.read',
            description:
                'Read the project wiki (state snapshot + change log). Prefer this over re-scanning the repository when you need the latest project status.',
            parameters: {
                type: 'object',
                properties: {
                    section: {
                        type: 'string',
                        enum: ['snapshot', 'log', 'all'],
                        description:
                            'snapshot = project state (default); log = change entries; all = both',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max change-log entries to return (default: all)',
                    },
                },
            },
            minPermission: 'read-only',
            sideEffects: [],
            impl: async (args) => {
                const section = args.section;
                const result = wiki.readForTool({
                    ...(section === 'snapshot' || section === 'log' || section === 'all'
                        ? { section }
                        : {}),
                    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
                });
                return result.ok
                    ? { ok: true, content: result.content ?? '' }
                    : { ok: false, error: result.error ?? 'wiki.read failed' };
            },
        },
        {
            name: 'wiki.update',
            description:
                'Update the project wiki: replace the state snapshot and/or append functional-level change entries (one short line each, no file names). Use at the end of a session that changed the project.',
            parameters: {
                type: 'object',
                properties: {
                    snapshot: {
                        type: 'string',
                        description:
                            'Full markdown snapshot; must contain at least one "## " section (概览/结构与模块/模块职责/进行中的工作/约定与注意)',
                    },
                    entries: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'Functional-level change descriptions, e.g. "新增项目 wiki 的读取与上下文注入"',
                    },
                },
            },
            minPermission: 'draft',
            sideEffects: ['fs'],
            impl: async (args) => {
                const result = await wiki.updateForTool({
                    ...(typeof args.snapshot === 'string' ? { snapshot: args.snapshot } : {}),
                    ...(typeof args.entries === 'string'
                        ? { entries: args.entries }
                        : Array.isArray(args.entries)
                          ? {
                                entries: args.entries.filter(
                                    (item): item is string => typeof item === 'string',
                                ),
                            }
                          : {}),
                });
                return result.ok
                    ? { ok: true, content: result.content ?? '' }
                    : { ok: false, error: result.error ?? 'wiki.update failed' };
            },
        },
    ];
}
