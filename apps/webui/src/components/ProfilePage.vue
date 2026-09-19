<script setup>
/**
 * ProfilePage — 用户画像（个人中心 → 画像）。
 *
 * 数据来自 GET /api/users/:userId/profile：本期只呈现机械特征简单统计；
 * 认知/性情/价值观等 LLM 维度待独立分析器，页面不臆造结论。
 */
import { computed, onMounted, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { effectiveDistribution } from '../scripts/question-stats.ts';
import { fetchUserProfile, fetchUserQuestions } from '../scripts/store.ts';

const emit = defineEmits(['close']);

const profile = ref(null);
const questions = ref([]);
const loading = ref(true);
const error = ref('');

/** 问题主域分布（来自有效标签，机械统计）。 */
const domainDistribution = computed(() => effectiveDistribution(questions.value, 'domain'));

/** 加载完成前的占位（全 0，不臆造）。 */
const EMPTY = {
    total: 0,
    questions: 0,
    feedback: 0,
    interrupts: 0,
    ratings: 0,
    ratingAverage: null,
    approvals: 0,
    granted: 0,
    denied: 0,
    denyRate: null,
    avgApprovalLatencyMs: null,
    sufficient: false,
};
const summary = computed(() => profile.value?.summary ?? EMPTY);
const sampleState = computed(() => (summary.value.sufficient ? '样本充足' : '样本不足（<8）'));

function fmtPercent(value) {
    return value === null ? '-' : (value * 100).toFixed(1) + '%';
}
function fmtMs(value) {
    if (value === null) return '-';
    return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(1) + 's';
}

onMounted(async () => {
    try {
        const [profileData, questionRows] = await Promise.all([
            fetchUserProfile('all'),
            fetchUserQuestions('all', { limit: 500 }),
        ]);
        profile.value = profileData;
        questions.value = questionRows;
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
            <h1>用户画像</h1>
            <span class="profile-badge">{{ summary.total }} 条行为 · {{ sampleState }}</span>
        </div>
        <p class="profile-note">
            机械特征（本机用户行为流，简单统计）；认知 / 性情 / 价值观等 LLM 维度待独立分析器生成。
        </p>
        <div v-if="error" class="empty-hint">{{ error }}</div>
        <div v-else-if="loading" class="empty-hint">加载中…</div>
        <div v-else class="profile-grid">
            <div class="profile-stat">
                <span class="profile-stat-num">{{ summary.questions }}</span>
                <span class="profile-stat-label">提问</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-num">{{ summary.feedback }}</span>
                <span class="profile-stat-label">反馈</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-num">{{ summary.ratingAverage === null ? '-' : summary.ratingAverage.toFixed(1) }}</span>
                <span class="profile-stat-label">平均评分（{{ summary.ratings }} 次）</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-num">{{ summary.approvals }}</span>
                <span class="profile-stat-label">审批发起</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-num">{{ fmtPercent(summary.denyRate) }}</span>
                <span class="profile-stat-label">拒绝率（{{ summary.granted }} 允许 / {{ summary.denied }} 拒绝）</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-num">{{ fmtMs(summary.avgApprovalLatencyMs) }}</span>
                <span class="profile-stat-label">平均授权延迟</span>
            </div>
            <div class="profile-stat">
                <span class="profile-stat-num">{{ summary.interrupts }}</span>
                <span class="profile-stat-label">主动中断</span>
            </div>
        </div>

        <div class="profile-section">
            <div class="profile-section-title">问题类别分布</div>
            <div v-if="domainDistribution.length" class="profile-bars">
                <div v-for="row in domainDistribution" :key="row.label" class="profile-bar-row">
                    <span class="profile-bar-label">{{ row.label }}</span>
                    <span class="profile-bar-track">
                        <span
                            class="profile-bar-fill"
                            :style="{ width: (row.count / domainDistribution[0].count) * 100 + '%' }"
                        ></span>
                    </span>
                    <span class="profile-bar-count">{{ row.count }}</span>
                </div>
            </div>
            <div v-else class="empty-hint">暂无问题标签（新会话或回填历史提问后出现）</div>
        </div>
    </div>
</template>

<style scoped>
.profile-badge {
    margin-left: auto;
    font-size: 12px;
    color: var(--fg-tertiary);
}
.profile-note {
    margin: 4px 0 16px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg-secondary);
}
.profile-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 12px;
}
.profile-stat {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
}
.profile-stat-num {
    font-size: 22px;
    font-weight: 600;
    color: var(--fg);
    font-variant-numeric: tabular-nums;
}
.profile-stat-label {
    font-size: 12px;
    color: var(--fg-secondary);
}
.profile-section {
    margin-top: 24px;
}
.profile-section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
    margin-bottom: 10px;
}
.profile-bars {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.profile-bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
}
.profile-bar-label {
    width: 110px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--fg-secondary);
}
.profile-bar-track {
    flex: 1;
    height: 8px;
    border-radius: 4px;
    background: var(--bg-hover);
    overflow: hidden;
}
.profile-bar-fill {
    display: block;
    height: 100%;
    background: var(--accent);
}
.profile-bar-count {
    width: 32px;
    text-align: right;
    font-size: 12px;
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
}
</style>
