<script setup>
import { computed } from 'vue';
import { isLabTabId } from '../scripts/lab-tabs.ts';
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

// 分类名与说明由左侧导航的选中态表达，主区不再重复一层标题。
const activeTab = computed(() => (isLabTabId(props.tab) ? props.tab : 'ab'));
</script>

<template>
    <section class="lab-page">
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
.lab-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
.lab-body > * {
    height: 100%;
}
</style>
