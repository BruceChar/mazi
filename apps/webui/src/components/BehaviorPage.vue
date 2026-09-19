<script setup>
/**
 * BehaviorPage — 行为链（个人中心 → 行为链）。
 *
 * 数据来自 GET /api/users/:userId/behaviors：聚合本机全部会话（当前 Conversation 之外
 * 的历史 run 也含在内），按 ts 升序展示**用户行为**（提问/反馈/授权）。
 * 审批请求是 harness 发起的锚点（非用户行为），作为授权的引用对象内联展示。
 */
import { isUserBehavior } from '@mazi/libs';
import { computed, onMounted, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { fetchUserBehaviors } from '../scripts/store.ts';

const emit = defineEmits(['close']);

const behaviors = ref([]);
const loading = ref(true);
const error = ref('');

/** 用户行为链只展示用户行为；审批锚点通过 ref 解析后内联到授权行。 */
const visible = computed(() => behaviors.value.filter((behavior) => isUserBehavior(behavior)));
const approvalByTs = computed(() => {
    const map = new Map();
    for (const behavior of behaviors.value) {
        if (behavior.type === 'approval') map.set(behavior.ts, behavior);
    }
    return map;
});

const LABELS = {
    input: '提问',
    feedback: '反馈',
    authorization: '授权',
    approval: '审批',
    setting: '设置',
    session: '会话',
};

function labelOf(type) {
    return LABELS[type] || type;
}
function timeOf(ts) {
    return new Date(ts).toLocaleString();
}
function detailOf(behavior) {
    const data = behavior.data || {};
    if (behavior.type === 'input') return data.text || '';
    if (behavior.type === 'feedback') {
        if (data.kind === 'rating') return '评分 ' + (data.rating ?? '-');
        if (data.kind === 'interrupt') return '主动中断';
        return data.text || '';
    }
    if (behavior.type === 'approval') return data.summary || data.capability || '待审批';
    if (behavior.type === 'authorization') {
        const decision =
            data.decision === 'granted' ? '允许' : data.decision === 'denied' ? '拒绝' : data.decision;
        // 审批请求是授权的引用对象（harness 发起）：内联展示其摘要，不单独成行。
        const approval = behavior.ref ? approvalByTs.value.get(behavior.ref.ts) : undefined;
        const request = approval ? approval.data.summary || approval.data.capability || '' : '';
        const latency = typeof data.latencyMs === 'number' ? data.latencyMs + 'ms' : '';
        return [decision, request, data.scope, latency].filter(Boolean).join(' · ');
    }
    return JSON.stringify(data);
}

onMounted(async () => {
    try {
        behaviors.value = await fetchUserBehaviors('all');
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
});
</script>

<template>
    <div class="page-card">
        <div class="page-heading">
            <button class="icon-btn back-btn" title="返回会话" @click="emit('close')">
                <LineIcon name="chevronRight" size="16" />
            </button>
            <h1>行为链</h1>
            <span class="behavior-badge">{{ visible.length }} 条</span>
        </div>
        <div v-if="error" class="empty-hint">{{ error }}</div>
        <div v-else-if="loading" class="empty-hint">加载中…</div>
        <div v-else-if="visible.length" class="behavior-list">
            <div
                v-for="behavior in visible"
                :key="behavior.ts"
                class="behavior-row"
                :class="'behavior-row-' + behavior.type"
            >
                <span class="behavior-tag">{{ labelOf(behavior.type) }}</span>
                <span class="behavior-text">{{ detailOf(behavior) }}</span>
                <span class="behavior-time">{{ timeOf(behavior.ts) }}</span>
            </div>
        </div>
        <div v-else class="empty-hint">暂无用户行为</div>
    </div>
</template>

<style scoped>
.behavior-badge {
    margin-left: auto;
    font-size: 12px;
    color: var(--fg-tertiary);
}
.behavior-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.behavior-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-left: 2px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--fg-secondary);
}
.behavior-row-input {
    border-left-color: var(--accent);
}
.behavior-row-approval {
    border-left-color: var(--warn);
}
.behavior-row-authorization {
    border-left-color: var(--fg-tertiary);
}
.behavior-tag {
    flex-shrink: 0;
    width: 36px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
}
.behavior-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.behavior-time {
    flex-shrink: 0;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg-tertiary);
}
</style>
