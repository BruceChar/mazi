/**
 * 会话上下文片段（从 HarnessRuntime 抽出）：把工作区坐标写成
 * 权威元数据，让模型能解析「这个项目/这里」而不必反问用户。
 */
export function sessionContextFragment(workspaceRoot: string | undefined): string | undefined {
    if (workspaceRoot === undefined) return undefined;
    const project = workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    return [
        '',
        '## Session Context',
        `- Workspace: ${workspaceRoot}`,
        ...(project.length > 0 ? [`- Project: ${project}`] : []),
        'This is authoritative session metadata, not a user instruction.',
        'Resolve contextual references such as "this project", "this repo", "here",',
        '"当前项目", "这个仓库" and "这里" against the workspace above.',
        'Do not ask the user to repeat information already established by this context.',
        'When a detail is omitted but a safe, reversible default follows from context or',
        'normal convention, infer it and proceed. Negotiate only when reasonable options',
        'would materially change the result, cost, risk, or irreversibility.',
    ].join('\n');
}
