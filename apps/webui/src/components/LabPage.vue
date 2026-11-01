<script setup>
import { ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import EvalLabPage from './EvalLabPage.vue';
import ExperimentsPage from './ExperimentsPage.vue';

defineProps({
    models: { type: Array, default: () => [] },
    workspace: { type: String, default: '' },
});
const emit = defineEmits(['close']);
const tab = ref('ab');
</script>

<template>
    <section class="lab-page">
        <header class="lab-head">
            <div class="lab-title">
                <LineIcon name="hammer" :size="17" />
                <strong>Lab</strong>
                <span>受控实验与固定回归是两个独立子集</span>
            </div>
            <div class="lab-actions">
                <div class="lab-tabs">
                    <button type="button" :class="{ on: tab === 'ab' }" @click="tab = 'ab'">
                        AB 实验
                    </button>
                    <button
                        type="button"
                        :class="{ on: tab === 'benchmark' }"
                        @click="tab = 'benchmark'"
                    >
                        Benchmark
                    </button>
                </div>
                <button type="button" @click="emit('close')">返回对话</button>
            </div>
        </header>
        <div class="lab-body">
            <ExperimentsPage v-if="tab === 'ab'" />
            <EvalLabPage
                v-else
                embedded
                :models="models"
                :workspace="workspace"
            />
        </div>
    </section>
</template>

<style scoped>
.lab-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
}
.lab-head,
.lab-title,
.lab-actions,
.lab-tabs {
    display: flex;
    align-items: center;
}
.lab-head {
    justify-content: space-between;
    gap: 10px;
    padding: 10px 16px 0;
}
.lab-title {
    gap: 8px;
}
.lab-title span {
    color: var(--fg-tertiary);
    font-size: 11px;
}
.lab-actions,
.lab-tabs {
    gap: 7px;
}
.lab-tabs {
    padding: 2px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
}
.lab-actions button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
}
.lab-tabs button {
    border: none;
    background: transparent;
}
.lab-tabs button.on {
    background: var(--bg-active);
    color: var(--fg);
}
.lab-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
.lab-body > * {
    height: 100%;
}
</style>
