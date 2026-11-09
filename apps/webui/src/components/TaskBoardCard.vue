<script setup>
/**
 * TaskBoardCard — 多 Task 计划的任务清单卡。
 *
 * 两种形态：
 * - strip：执行中固定在输入框上方，横向列出每个 Task 的名字与状态；
 * - summary：执行结束后附在会话流末尾，纵向罗列同一份清单。
 * 点击任一 Task → 通知父组件滚动定位到 Goal→Task 树，并同步审计选中。
 */
defineProps({
    tasks: { type: Array, default: () => [] },
    /** strip = 输入框上方固定条；summary = 会话末尾汇总。 */
    mode: { type: String, default: 'strip' },
    /** 当前审计选中的 Task（高亮对应行）。 */
    activeTaskId: { type: String, default: '' },
});
const emit = defineEmits(['locate']);
</script>

<template>
    <aside
        v-if="mode === 'strip'"
        class="task-board strip"
        aria-label="任务清单"
    >
        <div class="task-board-head">
            <span class="task-board-title">任务清单</span>
            <span class="task-board-count">{{ tasks.length }}</span>
        </div>
        <div class="task-board-items">
            <button
                v-for="(task, index) in tasks"
                :key="task.taskId"
                type="button"
                class="task-chip"
                :class="[task.tone, { active: task.taskId === activeTaskId }]"
                :title="task.title"
                @click="emit('locate', task.taskId)"
            >
                <span class="task-loc">T#{{ index + 1 }}</span>
                <span class="task-name">{{ task.title }}</span>
                <span class="task-state" :class="task.tone">{{ task.statusLabel }}</span>
            </button>
        </div>
    </aside>

    <section
        v-else
        class="task-board summary"
        aria-label="任务清单"
    >
        <header class="task-board-head">
            <span class="task-board-title">任务清单</span>
            <span class="task-board-count">{{ tasks.length }} tasks</span>
        </header>
        <button
            v-for="(task, index) in tasks"
            :key="task.taskId"
            type="button"
            class="task-row"
            :class="[task.tone, { active: task.taskId === activeTaskId }]"
            :title="task.title"
            @click="emit('locate', task.taskId)"
        >
            <span class="task-loc">T#{{ index + 1 }}</span>
            <span class="task-name">{{ task.title }}</span>
            <span class="task-state" :class="task.tone">{{ task.statusLabel }}</span>
        </button>
    </section>
</template>

<style scoped>
/* ---------- 输入框上方固定条 ---------- */
.task-board.strip {
    max-width: 760px;
    width: calc(100% - 32px);
    margin: 0 auto 6px;
    padding: 7px 9px 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.08));
}
.task-board-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
}
.task-board-title {
    color: var(--fg-secondary);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
}
.task-board-count {
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg-hover);
    color: var(--fg-tertiary);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
}
.task-board-items {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 1px;
    scrollbar-width: thin;
}
.task-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    max-width: 260px;
    padding: 5px 8px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg-secondary);
    cursor: pointer;
}
.task-chip:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
}
.task-chip.active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
}
.task-loc {
    flex-shrink: 0;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    font-size: 9px;
}
.task-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
}
/* 状态色与 Task 树徽标保持一致 */
.task-state {
    flex-shrink: 0;
    padding: 0 4px;
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 9px;
    line-height: 15px;
    color: var(--fg-tertiary);
}
.task-state.pending {
    color: var(--fg-tertiary);
}
.task-state.running,
.task-state.ok {
    border-color: var(--accent);
    color: var(--accent);
}
.task-state.fail {
    border-color: var(--error);
    color: var(--error);
}
.task-state.aborted,
.task-state.skipped {
    border-color: var(--warn);
    color: var(--fg-tertiary);
}

/* ---------- 会话末尾汇总 ---------- */
.task-board.summary {
    width: 100%;
    max-width: var(--chat-max, 880px);
    margin: 0 auto 16px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
}
.task-board.summary .task-board-head {
    margin-bottom: 8px;
}
.task-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 2px;
    border: 0;
    border-top: 1px solid var(--border-soft);
    background: transparent;
    color: var(--fg-secondary);
    text-align: left;
    cursor: pointer;
}
.task-row:first-of-type {
    border-top: 0;
}
.task-row:hover {
    color: var(--fg);
    background: var(--bg-hover);
}
.task-row.active {
    box-shadow: inset 2px 0 0 var(--accent);
}
.task-row .task-name {
    flex: 1;
    font-size: 12px;
}
</style>
