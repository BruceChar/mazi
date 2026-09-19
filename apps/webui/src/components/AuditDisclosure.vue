<script setup>
/**
 * AuditDisclosure —— 审计面板统一的「行 + 可折叠明细」组件。
 * 折叠 icon 不常驻：hover 或已展开时才显现；点击整行触发展开/收起。
 * 默认 slot = 行右侧的值；body slot = 展开后的明细内容。
 */
import LineIcon from '../assets/LineIcon.vue';

defineProps({
    open: { type: Boolean, default: false },
    label: { type: String, required: true },
    title: { type: String, default: '' },
});
defineEmits(['toggle']);
</script>

<template>
    <button type="button" class="disclosure-row" :class="{ open }" :title="title" @click="$emit('toggle')">
        <span class="disclosure-key">
            <span class="disclosure-caret">
                <LineIcon :name="open ? 'chevronDown' : 'chevronRight'" size="10" />
            </span>
            {{ label }}
        </span>
        <span class="disclosure-val"><slot /></span>
    </button>
    <div v-if="open" class="disclosure-body"><slot name="body" /></div>
</template>

<style scoped>
.disclosure-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    margin: 3px 0;
    padding: 3px 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 12px;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
}
.disclosure-row:hover,
.disclosure-row.open {
    background: var(--bg-hover);
}
.disclosure-key {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    color: var(--fg-tertiary);
}
.disclosure-caret {
    display: inline-grid;
    place-items: center;
    color: var(--fg-tertiary);
    opacity: 0;
    transition: opacity 0.1s ease;
}
.disclosure-row:hover .disclosure-caret,
.disclosure-row.open .disclosure-caret {
    opacity: 1;
}
.disclosure-val {
    color: var(--fg);
    font-family: ui-monospace, monospace;
    text-align: right;
    word-break: break-word;
}
.disclosure-body {
    min-width: 0;
}
</style>
