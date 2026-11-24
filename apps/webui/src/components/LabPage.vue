<script setup>
import { computed } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { isLabTabId, LAB_TABS } from '../scripts/lab-tabs.ts';
import EvalDashboardPage from './EvalDashboardPage.vue';
import EvalLabPage from './EvalLabPage.vue';
import ExperimentsPage from './ExperimentsPage.vue';

const props = defineProps({
    models: { type: Array, default: () => [] },
    workspace: { type: String, default: '' },
    /** 当前分类由左侧整页导航持有，本页只负责渲染内容。 */
    tab: { type: String, default: 'ab' },
});
const emit = defineEmits(['open-trace']);

const activeTab = computed(() => (isLabTabId(props.tab) ? props.tab : 'ab'));
const activeMeta = computed(
    () => LAB_TABS.find((item) => item.id === activeTab.value) ?? LAB_TABS[0],
);
</script>

<template>
    <section class="lab-page">
        <header class="lab-head">
            <div class="lab-title">
                <LineIcon :name="activeMeta.icon" :size="17" />
                <strong>{{ activeMeta.label }}</strong>
                <span>{{ activeMeta.hint }}</span>
            </div>
        </header>
        <div class="lab-body">
            <EvalDashboardPage
                v-if="activeTab === 'evals'"
                embedded
                @open-trace="emit('open-trace', $event)"
            />
            <ExperimentsPage v-else-if="activeTab === 'ab'" />
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
.lab-title {
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
.lab-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
.lab-body > * {
    height: 100%;
}
</style>
