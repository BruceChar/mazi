/** 单一 Session 的时间行：用户输入 1 条 + Turn/Step 顺序展开 */
export function flattenSessionFlow(session) {
    const rows = [];
    if (session?.rawIntent) {
        rows.push({
            type: 'user',
            key: `user:${session.sessionId}`,
            session,
            text: session.rawIntent,
            createdAt: session.createdAt ?? 0,
        });
    }
    for (const turn of session?.turns || []) {
        for (const step of turn.steps || []) {
            rows.push({
                type: 'step',
                key: `step:${session?.sessionId}:${step.stepId}`,
                session,
                turn,
                step,
                createdAt: step.startedAt ?? 0,
            });
        }
    }
    return rows;
}

/** Conversation 全部 Session 合并为一条连续对话流（按创建/发生时间排序） */
export function flattenConversationFlow(sessions) {
    const ordered = [...(sessions || [])].sort((a, b) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0));
    return ordered.flatMap((session) => flattenSessionFlow(session));
}
