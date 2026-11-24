<script setup>
/**
 * BehaviorPage — 用户中心「行为链」容器：行为分析 + 权限审计 两个子视图。
 *
 * 「行为分析」：用户提问/反馈/授权的个人履历（user_behaviors）。
 * 「权限审计」：跨全部历史 run 的权限决策事件（用户批准/拒绝、Agent 放行、
 * 策略拒绝、记忆命中），与右侧当前 run 面板同源。
 */
import { ref } from 'vue';
import BehaviorAnalysis from './BehaviorAnalysis.vue';
import PermissionAuditPanel from './PermissionAuditPanel.vue';

const tab = ref('analysis');
</script>

<template>
    <div class="uc-panel behavior-page">
        <div class="behavior-subtabs">
            <button :class="{ on: tab === 'analysis' }" @click="tab = 'analysis'">行为分析</button>
            <button :class="{ on: tab === 'audit' }" @click="tab = 'audit'">权限审计</button>
        </div>
        <BehaviorAnalysis v-if="tab === 'analysis'" />
        <PermissionAuditPanel v-else />
    </div>
</template>

<style scoped>
.behavior-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.behavior-subtabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
}
.behavior-subtabs button {
    padding: 6px 14px;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    font-size: 13px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
}
.behavior-subtabs button.on {
    color: var(--fg);
    font-weight: 600;
    border-bottom-color: var(--accent);
}
</style>
