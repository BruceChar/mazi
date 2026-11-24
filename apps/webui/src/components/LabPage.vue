<script setup>
import { computed } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { LAB_TABS } from '../scripts/lab-tabs.ts';
import EvalLabPage from './EvalLabPage.vue';
import ExperimentsPage from './ExperimentsPage.vue';

const props = defineProps({
    models: { type: Array, default: () => [] },
    workspace: { type: String, default: '' },
    /** 当前分类由左侧整页导航持有，本页只负责渲染内容。 */
    tab: { type: String, default: 'ab' },
});

const activeTab = computed(() => (props.tab === 'benchmark' ? 'benchmark' : 'ab'));
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
                <span>{{
                    activeTab === 'ab'
                        ? '受控 A/B 对照：同一任务分两臂执行，比较差异'
                        : '固定任务集回归：模型或 Prompt 改动后的基线校验'
                }}</span>
            </div>
        </header>
        <div class="lab-body">
            <ExperimentsPage v-if="activeTab === 'ab'" />
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
