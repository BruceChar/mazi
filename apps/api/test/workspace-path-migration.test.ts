import 'reflect-metadata';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiRuntimeService } from '../src/common/runtime.service.js';
import { ConversationsService } from '../src/conversations/conversations.service.js';

function makeHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'mazi-workspace-path-'));
    process.env.MAZI_HOME = home;
    return home;
}

function writeWorkspaces(home: string, state: unknown): void {
    writeFileSync(join(home, 'workspaces.json'), JSON.stringify(state));
}

function readWorkspaces(home: string): {
    projects: Array<{ title: string; path: string; sessionIds?: string[] }>;
    freeChatWorkspace?: string;
} {
    return JSON.parse(readFileSync(join(home, 'workspaces.json'), 'utf8'));
}

function writeConversations(home: string, conversations: unknown[]): void {
    writeFileSync(join(home, 'conversations.json'), JSON.stringify({ conversations }));
}

function readConversations(home: string): {
    conversations: Array<{
        conversationId: string;
        workspace?: string;
        projectId?: string;
    }>;
} {
    return JSON.parse(readFileSync(join(home, 'conversations.json'), 'utf8'));
}

describe('workspaces.json 路径归一化 + 去重（legacy 数据自动迁移）', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
        delete process.env.MAZI_HOME;
    });

    it('启动读取即把「带尾斜杠 + 不带尾斜杠」的重复项目合并为一条并回写', () => {
        const h = makeHome();
        writeWorkspaces(h, {
            projects: [
                { title: 'whoami', path: '/Users/bruce/nodejs/whoami/' },
                { title: 'whoami', path: '/Users/bruce/nodejs/whoami' },
                { title: 'boss简历投递', path: '/Users/bruce/Documents/boss简历投递/' },
                { title: 'boss简历投递', path: '/Users/bruce/Documents/boss简历投递' },
                { title: '', path: '/tmp/named-later/' },
                { title: 'named-later', path: '/tmp/named-later' },
            ],
            freeChatWorkspace: join(h, 'chat') + '/',
        });

        const service = new ApiRuntimeService();

        expect(service.projects()).toEqual([
            { title: 'whoami', path: '/Users/bruce/nodejs/whoami' },
            { title: 'boss简历投递', path: '/Users/bruce/Documents/boss简历投递' },
            { title: 'named-later', path: '/tmp/named-later' },
        ]);
        const persisted = readWorkspaces(h);
        expect(persisted.projects).toHaveLength(3);
        expect(persisted.projects.every((project) => !project.path.endsWith('/'))).toBe(true);
        // 随心聊默认工作区同样去掉尾斜杠
        expect(persisted.freeChatWorkspace).toBe(join(h, 'chat'));
        expect(service.freeChatWorkspace).toBe(join(h, 'chat'));
    });

    it('合并重复条目时保留 sessionIds 并集，且重复读取幂等（不会反复写盘）', () => {
        const h = makeHome();
        writeWorkspaces(h, {
            projects: [
                { title: 'p', path: '/p/', sessionIds: ['s1'] },
                { title: 'p', path: '/p', sessionIds: ['s3'] },
                { title: 'p', path: '/p/', sessionIds: ['s2', 's1'] },
            ],
        });

        const service = new ApiRuntimeService();
        expect(service.projects()).toEqual([{ title: 'p', path: '/p' }]);
        expect(readWorkspaces(h).projects).toEqual([
            { title: 'p', path: '/p', sessionIds: ['s1', 's3', 's2'] },
        ]);
        const afterMigration = readFileSync(join(h, 'workspaces.json'), 'utf8');
        for (let i = 0; i < 3; i++) {
            expect(service.projects()).toEqual([{ title: 'p', path: '/p' }]);
        }
        expect(readFileSync(join(h, 'workspaces.json'), 'utf8')).toBe(afterMigration);
    });

    it('setWorkspaceRoot 不再因尾斜杠生成重复项目；rename/remove 接受任一形式', () => {
        const h = makeHome();
        const projectDir = join(h, 'project-a');
        mkdirSync(projectDir, { recursive: true });
        writeWorkspaces(h, { projects: [{ title: 'legacy', path: projectDir + '/' }] });

        const service = new ApiRuntimeService();
        service.setWorkspaceRoot(projectDir + '/');
        expect(service.selectedWorkspaceRoot).toBe(projectDir);
        expect(service.projects()).toEqual([{ title: 'legacy', path: projectDir }]);

        service.renameProject(projectDir + '/', 'renamed');
        expect(service.projects()).toEqual([{ title: 'renamed', path: projectDir }]);

        service.removeProjectConfig(projectDir);
        expect(service.projects()).toEqual([]);
        expect(readWorkspaces(h).projects).toEqual([]);
    });

    it('实际挂载新工作区时按归一化路径判重（不存在尾斜杠重复）', () => {
        const h = makeHome();
        const projectDir = join(h, 'new-project');
        mkdirSync(projectDir, { recursive: true });
        writeWorkspaces(h, { projects: [] });

        const service = new ApiRuntimeService();
        service.setWorkspaceRoot(projectDir + '/');
        service.setWorkspaceRoot(projectDir);
        expect(service.selectedWorkspaceRoot).toBe(projectDir);
        expect(service.projects()).toEqual([{ title: 'new-project', path: projectDir }]);
    });
});

describe('conversations.json 工作区归属归一化（保证 WebUI 精确分组不分裂）', () => {
    let home: string | undefined;
    afterEach(() => {
        if (home) rmSync(home, { recursive: true, force: true });
        home = undefined;
        delete process.env.MAZI_HOME;
    });

    it('读取时归一化 workspace 与路径形态 projectId，并一次性回写', async () => {
        const h = makeHome();
        const projectDir = join(h, 'project-a');
        mkdirSync(projectDir, { recursive: true });
        writeWorkspaces(h, { projects: [{ title: 'project-a', path: projectDir + '/' }] });
        writeConversations(h, [
            {
                conversationId: 'legacy-path-project',
                title: 'legacy',
                userId: 'alice',
                runs: [{ rootGoalId: 'g1', input: 'hi', createdAt: 1 }],
                workspace: projectDir + '/',
                projectId: projectDir + '/',
                createdAt: 1,
                updatedAt: 1,
            },
            {
                conversationId: 'hash-project',
                title: 'hash',
                runs: [{ rootGoalId: 'g2', input: 'hi', createdAt: 2 }],
                workspace: projectDir + '/',
                projectId: 'b1bfc5a1be89bbf5',
                createdAt: 2,
                updatedAt: 2,
            },
            {
                conversationId: 'chat',
                title: 'chat',
                runs: [{ rootGoalId: 'g3', input: 'hi', createdAt: 3 }],
                createdAt: 3,
                updatedAt: 3,
            },
        ]);

        const runtime = new ApiRuntimeService();
        const conversations = new ConversationsService(runtime);
        const list = await conversations.list();
        const byId = new Map(list.map((item) => [item.conversationId, item]));

        // UI 分组条件是 c.workspace === project.path；归一化后两者精确相等
        const project = runtime.projects()[0];
        expect(project?.path).toBe(projectDir);
        expect(byId.get('legacy-path-project')?.workspace).toBe(projectDir);
        expect(byId.get('legacy-path-project')?.workspace).toBe(project?.path);
        // projectId 为路径形态时归一化；hash 形态原样保留
        expect(byId.get('legacy-path-project')?.projectId).toBe(projectDir);
        expect(byId.get('hash-project')?.workspace).toBe(projectDir);
        expect(byId.get('hash-project')?.projectId).toBe('b1bfc5a1be89bbf5');
        // 随心聊不携带工作区
        expect(byId.get('chat')?.workspace).toBeUndefined();

        // 迁移已持久化：再次读取不再写盘
        const persisted = readConversations(h);
        expect(persisted.conversations[0]?.workspace).toBe(projectDir);
        expect(persisted.conversations[0]?.projectId).toBe(projectDir);
        const afterMigration = readFileSync(join(h, 'conversations.json'), 'utf8');
        await conversations.list();
        expect(readFileSync(join(h, 'conversations.json'), 'utf8')).toBe(afterMigration);

        // delete-project：调用方传带尾斜杠形式也能解除归属
        conversations.detachWorkspace(projectDir + '/');
        const detached = (await conversations.list()).find(
            (item) => item.conversationId === 'legacy-path-project',
        );
        expect(detached?.workspace).toBeUndefined();
        expect(detached?.projectId).toBeUndefined();
        // hash 项目会话同样被解除（同一 workspace）
        const hashDetached = (await conversations.list()).find(
            (item) => item.conversationId === 'hash-project',
        );
        expect(hashDetached?.workspace).toBeUndefined();
        expect(hashDetached?.projectId).toBeUndefined();
        // 随心聊会话不受影响
        expect(
            (await conversations.list()).find((item) => item.conversationId === 'chat')?.workspace,
        ).toBeUndefined();
    });

    it('新写入 Conversation 时立即归一化，不再产生带尾斜杠的旧形态', () => {
        const h = makeHome();
        const runtime = new ApiRuntimeService();
        const conversations = new ConversationsService(runtime);
        const id = conversations.recordNewRun({
            rootGoalId: 'g-new',
            input: 'hi',
            workspace: '/projects/new/',
            projectId: '/projects/new/',
        });
        const persisted = readConversations(h);
        const created = persisted.conversations.find((item) => item.conversationId === id);
        expect(created?.workspace).toBe('/projects/new');
        expect(created?.projectId).toBe('/projects/new');
        // 服务实例内的返回同样是归一化值
        expect(conversations.context(id).workspace).toBe('/projects/new');
    });
});
