import { describe, expect, it } from 'vitest';
import { projectSessionIds, sessionsOutsideProjects } from './sidebar.ts';

const sessions = [
    { sessionId: 's1', title: '项目 A 会话' },
    { sessionId: 's2', title: '项目 A/B 会话' },
    { sessionId: 's3', title: '项目 B 会话' },
    { sessionId: 's4', title: '默认分组会话' },
];

const projects = [
    { title: 'project-a', path: '/a', sessionIds: ['s1', 's2'] },
    { title: 'project-b', path: '/b', sessionIds: ['s3'] },
];

describe('sidebar session grouping', () => {
    it('收集所有项目归属的会话 id', () => {
        expect(projectSessionIds(projects)).toEqual(new Set(['s1', 's2', 's3']));
    });

    it('默认分组只保留未归属任何项目的会话', () => {
        expect(sessionsOutsideProjects(sessions, projects).map((s) => s.sessionId)).toEqual(['s4']);
    });

    it('没有项目时全部会话留在默认分组', () => {
        expect(sessionsOutsideProjects(sessions, [])).toHaveLength(sessions.length);
    });

    it('缺失项目或会话字段时安全返回', () => {
        expect(sessionsOutsideProjects(undefined, projects)).toEqual([]);
        expect(projectSessionIds([{ title: 'x', path: '/x' }])).toEqual(new Set());
    });
});
