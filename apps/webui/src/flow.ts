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
    const finalAssistantStepId = finalThinkingStepId(session);
    for (const turn of session?.turns || []) {
        for (const step of turn.steps || []) {
            const isAssistantOutput =
                step.kind === 'thinking' && step.stepId === finalAssistantStepId;
            rows.push({
                type: isAssistantOutput ? 'assistant' : 'step',
                key: `step:${session?.sessionId}:${step.stepId}`,
                session,
                turn,
                step,
                text: step.payload?.content ?? '',
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

/** 已成功 Session 的最后一个成功 thinking Step 视为大模型最终输出 */
function finalThinkingStepId(session) {
    if (session?.outcome !== 'success') {
        return undefined;
    }
    const thinkingSteps = (session?.turns || []).flatMap((turn) =>
        (turn.steps || []).filter((step) => step.kind === 'thinking' && step.status === 'ok'),
    );
    return thinkingSteps.length > 0 ? thinkingSteps[thinkingSteps.length - 1].stepId : undefined;
}
