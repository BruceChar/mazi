<script setup>
import { computed } from 'vue';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    items: { type: Array, default: () => [] },
    activeRunId: { type: String, default: '' },
});
const emit = defineEmits(['select']);

const runningCount = computed(
    () => props.items.filter((item) => item.status === 'running').length,
);
const queuedCount = computed(
    () => props.items.filter((item) => item.status === 'queued').length,
);

function select(item) {
    if (item.status === 'running') emit('select', item.rootGoalId);
}
</script>

<template>
    <aside v-if="items.length" class="execution-queue" aria-label="执行任务队列">
        <header class="execution-queue-head">
            <LineIcon name="play" size="12" />
            <span class="execution-queue-title">执行任务</span>
            <span class="execution-queue-summary">
                {{ runningCount }} 执行中 · {{ queuedCount }} 排队
            </span>
        </header>
        <div class="execution-queue-items">
            <button
                v-for="(item, index) in items"
                :key="item.rootGoalId"
                type="button"
                class="execution-queue-row"
                :class="[item.status, { active: item.rootGoalId === activeRunId }]"
                :disabled="item.status !== 'running'"
                :title="item.input"
                @click="select(item)"
            >
                <span class="execution-queue-loc">Q#{{ index + 1 }}</span>
                <span class="execution-queue-name">{{ item.input }}</span>
                <span class="execution-queue-state">
                    {{ item.status === 'running' ? '执行中' : '排队中' }}
                </span>
            </button>
        </div>
    </aside>
</template>

<style scoped>
.execution-queue {
    width: calc(100% - 32px);
    max-width: 760px;
    margin: 0 auto 6px;
    padding: 7px 10px 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    box-shadow: var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.08));
}
.execution-queue-head {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-secondary);
    font-size: 11px;
}
.execution-queue-title {
    font-weight: 600;
}
.execution-queue-summary {
    margin-left: auto;
    color: var(--fg-tertiary);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
}
.execution-queue-items {
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-height: 150px;
    margin-top: 5px;
    overflow-y: auto;
}
.execution-queue-row {
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
}
.execution-queue-row:first-child {
    border-top: 0;
}
.execution-queue-row.running {
    cursor: pointer;
}
.execution-queue-row.running:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.execution-queue-row.queued {
    cursor: default;
}
.execution-queue-row.active {
    box-shadow: inset 2px 0 0 var(--accent);
}
.execution-queue-loc {
    flex-shrink: 0;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    font-size: 9px;
}
.execution-queue-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
}
.execution-queue-state {
    flex-shrink: 0;
    padding: 0 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    font-size: 9px;
    line-height: 16px;
}
.execution-queue-row.running .execution-queue-state {
    border-color: var(--accent);
    color: var(--accent);
}
</style>
