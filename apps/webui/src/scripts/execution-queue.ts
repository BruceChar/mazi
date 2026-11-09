export interface ExecutionQueueEntry {
    rootGoalId: string;
    conversationId: string;
    input: string;
}

export interface ExecutionQueueItem extends ExecutionQueueEntry {
    status: 'running' | 'queued';
    /** 排队任务可能先于前一项返回 HTTP；结果保留到它成为队首时再出队。 */
    finished?: boolean;
}

export interface CompleteExecutionResult {
    queue: ExecutionQueueItem[];
    next?: ExecutionQueueItem;
}

export function enqueueExecution(
    queue: readonly ExecutionQueueItem[],
    entry: ExecutionQueueEntry,
): ExecutionQueueItem[] {
    if (queue.some((item) => item.rootGoalId === entry.rootGoalId)) {
        return [...queue];
    }
    return [...queue, { ...entry, status: queue.length === 0 ? 'running' : 'queued' }];
}

export function completeExecution(
    queue: readonly ExecutionQueueItem[],
    rootGoalId: string,
): CompleteExecutionResult {
    const index = queue.findIndex((item) => item.rootGoalId === rootGoalId);
    if (index < 0) return { queue: [...queue] };

    if (index > 0) {
        return {
            queue: queue.map((item) =>
                item.rootGoalId === rootGoalId ? { ...item, finished: true } : item,
            ),
        };
    }

    const remaining = queue.filter((item) => item.rootGoalId !== rootGoalId);
    const firstUnfinished = remaining.findIndex((item) => item.finished !== true);
    if (firstUnfinished < 0) return { queue: [] };

    const next = remaining[firstUnfinished] as ExecutionQueueItem;
    const rest = remaining.slice(firstUnfinished + 1);
    return {
        queue: [{ ...next, status: 'running' }, ...rest],
        next: { ...next, status: 'running' },
    };
}

export function isExecutionQueued(
    queue: readonly ExecutionQueueItem[],
    rootGoalId: string,
): boolean {
    return queue.some((item) => item.rootGoalId === rootGoalId && item.status === 'queued');
}

/** 队列卡只展示等待执行的 run；当前 running run 已在会话窗口展示。 */
export function queuedExecutionItems(queue: readonly ExecutionQueueItem[]): ExecutionQueueItem[] {
    return queue.filter((item) => item.status === 'queued');
}

/** 没有 queued run 时不展示执行队列卡。 */
export function showExecutionQueueCard(queue: readonly ExecutionQueueItem[]): boolean {
    return queuedExecutionItems(queue).length > 0;
}
