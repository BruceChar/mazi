/** 收集所有工作区项目已归属的会话 id。 */
export function projectSessionIds(projects) {
    return new Set((projects || []).flatMap((project) => project.sessionIds || []).filter(Boolean));
}

/** 过滤掉已归属工作区项目的会话，剩余内容用于默认“会话”分组。 */
export function sessionsOutsideProjects(sessions, projects) {
    const assignedIds = projectSessionIds(projects);
    return (sessions || []).filter((session) => !assignedIds.has(session.sessionId));
}
