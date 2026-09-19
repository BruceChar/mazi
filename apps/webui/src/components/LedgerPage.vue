<script setup>
/**
 * LedgerPage — 失败分类账（个人中心 → 账本）。
 *
 * 后端 GET /api/ledger 尚未接入；此页为占位空态，避免入口悬空。
 */
import LineIcon from '../assets/LineIcon.vue';

const emit = defineEmits(['close']);
</script>

<template>
    <div class="page-card">
        <div class="page-heading">
            <button class="icon-btn back-btn" title="返回会话" @click="emit('close')">
                <LineIcon name="chevronRight" size="16" />
            </button>
            <h1>失败分类账</h1>
        </div>
        <div class="empty-hint">账本后端（GET /api/ledger）尚未接入，暂无可展示条目。</div>
    </div>
</template>
