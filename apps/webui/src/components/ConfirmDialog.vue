<script setup>
defineProps({
    open: { type: Boolean, default: false },
    title: { type: String, default: '' },
    message: { type: String, default: '' },
    confirmText: { type: String, default: 'Confirm' },
    danger: { type: Boolean, default: false },
});
const emit = defineEmits(['cancel', 'confirm']);
</script>

<template>
    <div v-if="open" class="modal-mask" @click.self="emit('cancel')">
        <div class="modal confirm-modal">
            <h1>{{ title }}</h1>
            <p class="confirm-message">{{ message }}</p>
            <div class="modal-actions">
                <button class="ghost" @click="emit('cancel')">Cancel</button>
                <button :class="danger ? 'danger' : 'primary'" @click="emit('confirm')">{{ confirmText }}</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.modal-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
}
.modal {
    background: var(--bg-panel);
    border-radius: 12px;
    padding: 24px;
    min-width: 360px;
    max-width: 90vw;
    box-shadow: var(--shadow-lg);
}
.confirm-modal h1 {
    font-size: 18px;
    margin: 0 0 12px;
}
.confirm-message {
    color: var(--fg-secondary);
    font-size: 14px;
    margin: 0 0 20px;
    line-height: 1.5;
}
.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
.modal-actions button {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
}
.modal-actions .primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
}
.modal-actions .danger {
    background: #ef4444;
    color: #fff;
    border-color: #ef4444;
}
</style>
