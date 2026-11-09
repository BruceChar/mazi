<script setup>
/**
 * TaskBoardCard — 多 Task 计划的任务清单卡。
 *
 * 两种形态：
 * - strip：执行中固定在输入框上方；
 * - summary：执行结束后附在会话流末尾。
 * 两种形态都是竖向任务列表，可折叠：折叠后只留标题行，展开显示完整清单。
 * 点击任一 Task → 通知父组件滚动定位到 Goal→Task 树，并同步审计选中。
 */
import { computed, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    tasks: { type: Array, default: () => [] },
    /** strip = 输入框上方固定卡；summary = 会话末尾汇总。 */
    mode: { type: String, default: 'strip' },
    /** 当前审计选中的 Task（高亮对应行）。 */
    activeTaskId: { type: String, default: '' },
});
const emit = defineEmits(['locate']);

/** 默认展开（完整清单）；用户可折叠成一行标题，给输入区让出空间。 */
const expanded = ref(true);
const doneCount = computed(
    () => props.tasks.filter((task) => task.tone === 'ok').length,
);
/** 折叠时的一行摘要：正在执行的 Task 优先，否则取第一个待执行。 */
const currentTask = computed(
    () =>
        props.tasks.find((task) => task.tone === 'running') ||
        props.tasks.find((task) => task.tone === 'pending') ||
        null,
);
function toggle() {
    expanded.value = !expanded.value;
}
</script>

<template>
    <aside
        v-if="mode === 'strip'"
        class="task-board strip"
        aria-label="任务清单"
    >
        <header class="task-board-head">
            <button
                type="button"
                class="task-board-toggle"
                :aria-expanded="expanded"
                :title="expanded ? '折叠任务清单' : '展开完整任务清单'"
                @click="toggle"
            >
                <LineIcon :name="expanded ? 'chevronDown' : 'chevronRight'" size="12" />
                <span class="task-board-title">任务清单</span>
                <span class="task-board-count">{{ tasks.length }}</span>
                <span class="task-board-progress">{{ doneCount }}/{{ tasks.length }} 完成</span>
            </button>
            <span v-if="!expanded && currentTask" class="task-board-current" :title="currentTask.title">
                <span class="task-loc">T#{{ tasks.indexOf(currentTask) + 1 }}</span>
                <span class="task-name">{{ currentTask.title }}</span>
                <span class="task-state" :class="currentTask.tone">{{ currentTask.statusLabel }}</span>
            </span>
        </header>
        <div v-if="expanded" class="task-board-items">
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
        </div>
    </aside>

    <section
        v-else
        class="task-board summary"
        aria-label="任务清单"
    >
        <header class="task-board-head">
            <button
                type="button"
                class="task-board-toggle"
                :aria-expanded="expanded"
                :title="expanded ? '折叠任务清单' : '展开完整任务清单'"
                @click="toggle"
            >
                <LineIcon :name="expanded ? 'chevronDown' : 'chevronRight'" size="12" />
                <span class="task-board-title">任务清单</span>
                <span class="task-board-count">{{ tasks.length }} tasks</span>
                <span class="task-board-progress">{{ doneCount }}/{{ tasks.length }} 完成</span>
            </button>
        </header>
        <div v-if="expanded" class="task-board-items">
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
        </div>
    </section>
</template>

<style scoped>
/* ---------- 输入框上方固定卡 / 会话末尾汇总 ---------- */
.task-board.strip {
    max-width: 760px;
    width: calc(100% - 32px);
    margin: 0 auto 6px;
    padding: 6px 9px 7px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.08));
}
.task-board.summary {
    width: 100%;
    max-width: var(--chat-max, 880px);
    margin: 0 auto 16px;
    padding: 9px 12px 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
}
.task-board-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.task-board-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 2px 4px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
}
.task-board-toggle:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.task-board-title {
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
.task-board-progress {
    color: var(--fg-tertiary);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
}
/* 折叠后的一行摘要：当前 Task 名称 + 状态 */
.task-board-current {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--fg-secondary);
}
.task-board-current .task-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
}

/* 竖向任务列表：展开后完整展示，任务多时卡内滚动 */
.task-board-items {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 180px;
    margin-top: 5px;
    overflow-y: auto;
}
.task-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 4px;
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
.task-loc {
    flex-shrink: 0;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    font-size: 9px;
}
.task-name {
    flex: 1;
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
</style>
