<script setup>
/**
 * FeedbackModal — captures an output rating plus an optional comment.
 *
 * Purely a controlled dialog: App.vue decides when it opens and forwards the
 * payload to the API. State resets on every open.
 */
import { ref, watch } from 'vue';

const props = defineProps({
    /** Controls visibility; opening the dialog resets rating/content. */
    open: { type: Boolean, default: false },
    /** Human-readable target of the feedback (usually the run id, truncated). */
    subject: { type: String, default: '' },
});
const emit = defineEmits(['close', 'submit']);

const rating = ref(5);
const content = ref('');

watch(
    () => props.open,
    (open) => {
        if (open) {
            rating.value = 5;
            content.value = '';
        }
    },
);

function submit() {
    emit('submit', { rating: rating.value, content: content.value });
}
</script>

<template>
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
        <div class="modal">
            <h1>反馈 · {{ subject }}</h1>
            <div class="field-row">
                <label>评分</label>
                <select v-model="rating">
                    <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
                </select>
            </div>
            <div class="field-row">
                <label>说明</label>
                <textarea v-model="content" rows="3" placeholder="补充说明（可选）"></textarea>
            </div>
            <div class="modal-actions">
                <button class="ghost" @click="emit('close')">取消</button>
                <button class="primary" @click="submit">提交</button>
            </div>
        </div>
    </div>
</template>
