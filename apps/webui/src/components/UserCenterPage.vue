<script setup>
/**
 * UserCenterPage — 用户中心整页（docs/webui.md §3.2）。
 *
 * 整页接管（与设置页 / Lab 同构）：分类导航由 App 的左栏承担（画像 / 记忆 / 问题 /
 * 权限审计 / 账本 / 用户设置 + 底部 Back to app），本页只渲染当前分类的内容。
 */
import { computed } from 'vue';
import { userCenterTabOf } from '../scripts/user-center.ts';
import BehaviorPage from './BehaviorPage.vue';
import LedgerPage from './LedgerPage.vue';
import MemoryGovernancePage from './MemoryGovernancePage.vue';
import ProfilePage from './ProfilePage.vue';
import QuestionsPage from './QuestionsPage.vue';
import UserPreferencesPage from './UserPreferencesPage.vue';

const props = defineProps({
    /** 当前 tab（外部持有，便于返回后保持原位）。 */
    tab: { type: String, default: 'profile' },
    projectId: { type: String, default: '' },
});

const activeTab = computed(() => userCenterTabOf(props.tab));
</script>

<template>
    <div class="user-center">
        <section class="uc-body">
            <ProfilePage v-if="activeTab === 'profile'" />
            <MemoryGovernancePage
                v-else-if="activeTab === 'memory'"
                embedded
                :project-id="projectId"
            />
            <QuestionsPage v-else-if="activeTab === 'questions'" />
            <BehaviorPage v-else-if="activeTab === 'behavior'" />
            <LedgerPage v-else-if="activeTab === 'ledger'" />
            <UserPreferencesPage v-else />
        </section>
    </div>
</template>

<style scoped>
/* 整页接管（与设置页 / Lab 同构）：不再有页头与横向 tab，分类导航在左栏。 */
.user-center {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* 内容区独占剩余高度并自行滚动，切分类不跳动整页。 */
.uc-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: clamp(16px, 3.2vw, 36px) clamp(16px, 4vw, 56px);
    box-sizing: border-box;
}
</style>
