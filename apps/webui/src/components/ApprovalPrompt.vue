<script setup>
/**
 * ApprovalPrompt — human-in-the-loop approval panel.
 *
 * Anchored above the composer (pop-up from the input box) and styled like the
 * system modals. Each entry carries the gateway's signed-echo summary; the
 * buttons map 1:1 onto ApprovalSettlement: granted(once|session|workspace) and
 * rejected.
 */
defineProps({
    approvals: { type: Array, default: () => [] },
});
const emit = defineEmits(['respond']);
</script>

<template>
    <div v-if="approvals.length" class="approval-pop" role="dialog" aria-label="权限审批">
        <div class="approval-pop-head">
            <span class="approval-dot"></span>
            <span>需要你的批准</span>
            <span v-if="approvals.length > 1" class="approval-count">{{ approvals.length }}</span>
        </div>
        <div class="approval-cards">
            <div v-for="item in approvals" :key="item.invocationId" class="approval-card">
                <pre class="approval-summary">{{ item.summary }}</pre>
                <div class="approval-actions">
                    <button
                        type="button"
                        class="ghost"
                        @click="emit('respond', { invocationId: item.invocationId, decision: 'rejected' })"
                    >
                        拒绝
                    </button>
                    <button
                        type="button"
                        class="ghost"
                        @click="
                            emit('respond', {
                                invocationId: item.invocationId,
                                decision: 'granted',
                                scope: 'once',
                            })
                        "
                    >
                        允许一次
                    </button>
                    <button
                        type="button"
                        class="ghost"
                        @click="
                            emit('respond', {
                                invocationId: item.invocationId,
                                decision: 'granted',
                                scope: 'session',
                            })
                        "
                    >
                        本会话允许
                    </button>
                    <button
                        type="button"
                        class="primary"
                        @click="
                            emit('respond', {
                                invocationId: item.invocationId,
                                decision: 'granted',
                                scope: 'workspace',
                            })
                        "
                    >
                        本工作区允许
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.approval-pop {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 8px);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    padding: 12px;
    z-index: 90;
    max-height: 46vh;
    overflow-y: auto;
}
.approval-pop-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
    margin-bottom: 10px;
}
.approval-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warn);
}
.approval-count {
    margin-left: auto;
    font-size: 12px;
    font-weight: 500;
    color: var(--fg-tertiary);
}
.approval-cards {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.approval-card {
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 10px;
    background: var(--bg-chat);
}
.approval-summary {
    margin: 0 0 8px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--fg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
}
.approval-actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
}
.approval-actions button {
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg);
}
.approval-actions button:hover {
    background: var(--bg-hover);
}
.approval-actions .primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
}
.approval-actions .ghost {
    color: var(--fg-secondary);
}
</style>
