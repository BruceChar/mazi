<script setup>
/**
 * PromptDialog — custom single-line input dialog.
 *
 * Replaces window.prompt so renaming stays inside the app shell and remains
 * keyboard accessible (Enter confirms, Escape cancels, the text is preselected).
 */
import { ref, watch } from 'vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    title: { type: String, default: '' },
    label: { type: String, default: '' },
    initialValue: { type: String, default: '' },
    confirmText: { type: String, default: '保存' },
    placeholder: { type: String, default: '' },
});
const emit = defineEmits(['cancel', 'confirm']);

const value = ref('');
const input = ref(null);

// Reset to the provided value on every open, then focus and select the text.
watch(
    () => props.open,
    (open) => {
        if (!open) return;
        value.value = props.initialValue;
        requestAnimationFrame(() => {
            input.value?.focus();
            input.value?.select();
        });
    },
);

function confirm() {
    const next = value.value.trim();
    if (!next) return;
    emit('confirm', next);
}
</script>

<template>
    <div v-if="open" class="modal-mask" @click.self="emit('cancel')">
        <div class="modal prompt-modal">
            <h1>{{ title }}</h1>
            <label class="field-label" for="prompt-dialog-input">{{ label }}</label>
            <input
                id="prompt-dialog-input"
                ref="input"
                v-model="value"
                class="prompt-input"
                :placeholder="placeholder"
                @keydown.enter.prevent="confirm"
                @keydown.esc="emit('cancel')"
            />
            <div class="modal-actions">
                <button class="ghost" @click="emit('cancel')">取消</button>
                <button class="primary" :disabled="!value.trim()" @click="confirm">
                    {{ confirmText }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Self-contained modal styles (mirrors ConfirmDialog) so the dialog does not
   depend on global modal class names. */
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
.prompt-modal h1 {
    font-size: 18px;
    margin: 0 0 16px;
}
.field-label {
    display: block;
    font-size: 12px;
    color: var(--fg-secondary);
    margin-bottom: 6px;
}
.prompt-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font-size: 14px;
    outline: none;
}
.prompt-input:focus {
    border-color: var(--accent);
}
.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
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
.modal-actions .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
</style>
