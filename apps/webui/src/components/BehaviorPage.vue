<script setup>
/**
 * BehaviorPage — 用户中心「权限审计」（原行为链位置）。
 *
 * 全局视角：跨全部历史 run 抽取权限事件（用户批准/拒绝、Agent 自动放行、
 * 策略拒绝、记忆命中、待审批、撤销、取消），保留角色、结果、工具、决策依据、
 * 作用域与锚点，支持角色/结果/工具/关键词/时间筛选。数据来自
 * GET /api/permissions/audit（无参 = 全量回放），与右侧当前 run 面板同源。
 */
import PermissionAuditPanel from './PermissionAuditPanel.vue';
</script>

<template>
    <div class="uc-panel">
        <PermissionAuditPanel />
    </div>
</template>

<style scoped>
.uc-panel {
    min-height: 0;
}
</style>
