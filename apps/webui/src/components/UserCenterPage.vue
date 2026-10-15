<script setup>
/**
 * UserCenterPage — 用户中心整页（docs/webui.md §3.2）。
 *
 * 取代此前的右上角下拉菜单：一页承载全部用户级资产，tab 平铺、可一键返回对话。
 * 只做页头 / tab 导航 / 滚动容器；各 tab 的内容与数据加载归各自的面板组件。
 */
import { computed } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { userPreferences } from '../scripts/store.ts';
import { USER_CENTER_TABS, userCenterTabOf } from '../scripts/user-center.ts';
import BehaviorPage from './BehaviorPage.vue';
import LedgerPage from './LedgerPage.vue';
import ProfilePage from './ProfilePage.vue';
import QuestionsPage from './QuestionsPage.vue';
import UserPreferencesPage from './UserPreferencesPage.vue';

const props = defineProps({
    /** 当前 tab（外部持有，便于返回后保持原位）。 */
    tab: { type: String, default: 'profile' },
});
const emit = defineEmits(['update:tab', 'close']);

const activeTab = computed(() => userCenterTabOf(props.tab));
const displayName = computed(() => userPreferences.displayName?.trim() || '本机用户');
</script>

<template>
    <div class="page-card user-center">
        <header class="uc-head">
            <div class="uc-head-main">
                <h1>用户中心</h1>
                <span class="uc-identity" title="在「用户设置」里修改">{{ displayName }}</span>
            </div>
            <button class="uc-back" title="返回对话（Esc）" @click="emit('close')">
                <LineIcon name="chevronLeft" size="14" />
                <span>返回对话</span>
            </button>
        </header>

        <nav class="uc-tabs">
            <button
                v-for="item in USER_CENTER_TABS"
                :key="item.id"
                class="uc-tab"
                :class="{ on: activeTab === item.id }"
                @click="emit('update:tab', item.id)"
            >
                <LineIcon :name="item.icon" size="14" />
                <span>{{ item.label }}</span>
            </button>
        </nav>

        <section class="uc-body">
            <ProfilePage v-if="activeTab === 'profile'" />
            <QuestionsPage v-else-if="activeTab === 'questions'" />
            <BehaviorPage v-else-if="activeTab === 'behavior'" />
            <LedgerPage v-else-if="activeTab === 'ledger'" />
            <UserPreferencesPage v-else />
        </section>
    </div>
</template>

<style scoped>
/* 整页卡片：页头与 tab 固定，只有内容区滚动（外层 .page-card 由 pages.css 提供）。 */
.user-center {
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.uc-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border-soft);
}
.uc-head-main {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
}
.uc-head h1 {
    margin: 0;
    font-size: 18px;
}
.uc-identity {
    flex-shrink: 0;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
}
.uc-back {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-secondary);
    font-size: 12px;
    cursor: pointer;
}
.uc-back:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-text);
}
.uc-tabs {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-soft);
}
.uc-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-secondary);
    font-size: 13px;
    cursor: pointer;
}
.uc-tab:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.uc-tab.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-text);
    font-weight: 600;
}
/* 内容区独占剩余高度并自行滚动，切 tab 不跳动整页。 */
.uc-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding-top: 12px;
}
</style>
