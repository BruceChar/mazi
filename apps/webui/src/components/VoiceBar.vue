<script setup>
/**
 * 语音状态条（docs/web/语音输入设计.md §5.3）。
 *
 * 显示状态 / 波形 / 暂停恢复 / 自动发送倒计时 / 浏览器云识别首次同意卡片 /
 * 本机模型安装入口。partial 只在 Composer 里做 ghost 展示，这里只播报状态。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import LineIcon from '../assets/LineIcon.vue';

const props = defineProps({
    controller: { type: Object, required: true },
});

const state = computed(() => props.controller.state);

const PHASE_LABELS = {
    requesting: '正在准备麦克风…',
    armed: '正在听…',
    capturing: '识别中…',
    partial: '识别中…',
    finalizing: '正在确认…',
    committed: '已写入草稿',
    error: '语音输入不可用',
    off: '',
};

const PAUSE_LABELS = {
    manual: '语音已暂停',
    busy: '执行中，语音已暂歇',
    blur: '已暂停（页面切到后台）',
    idle: '已暂停（空闲超时）',
    'other-tab': '另一标签页正在使用语音输入',
    consent: '等待浏览器识别确认',
    gesture: '点麦克风恢复语音输入',
};

const ACTIVE_PHASES = [
    'requesting',
    'armed',
    'capturing',
    'partial',
    'finalizing',
    'committed',
];

const phase = computed(() => state.value.phase);
const listening = computed(
    () => phase.value === 'armed' || phase.value === 'capturing' || phase.value === 'partial',
);
const canPause = computed(() => ACTIVE_PHASES.includes(phase.value));
const canResume = computed(
    () => phase.value === 'paused' && state.value.pauseReason !== 'busy',
);
const browserEngine = computed(
    () => state.value.engine === 'browser-cloud' || state.value.engine === 'browser-on-device',
);
const consentRequired = computed(() => Boolean(state.value.browserConsentRequired));
const modelMissing = computed(
    () => state.value.modelStatus === 'missing' || state.value.modelStatus === 'error',
);
const showModelCard = computed(
    () =>
        Boolean(state.value.installing) ||
        Boolean(state.value.downloadError) ||
        (phase.value === 'error' && state.value.error?.code === 'model_missing'),
);
const showInstallHint = computed(
    () =>
        !consentRequired.value &&
        !showModelCard.value &&
        browserEngine.value &&
        state.value.modelStatus !== 'ready' &&
        !state.value.capabilitiesError,
);
const visible = computed(
    () =>
        phase.value !== 'off' ||
        consentRequired.value ||
        Boolean(state.value.installing) ||
        Boolean(state.value.downloadError) ||
        Boolean(state.value.tabConflict),
);

const statusText = computed(() => {
    if (phase.value === 'paused') {
        return PAUSE_LABELS[state.value.pauseReason] || '语音已暂停';
    }
    return PHASE_LABELS[phase.value] || '';
});

const engineBadge = computed(() => {
    switch (state.value.engine) {
        case 'local':
            return '本机识别';
        case 'browser-on-device':
            return '浏览器本机识别';
        case 'browser-cloud':
            return '浏览器识别 · 可能上传音频';
        default:
            return '';
    }
});

/* 自动发送倒计时：只在有 endsAt 时启动 100ms ticker。 */
const nowMs = ref(Date.now());
let ticker = null;
function stopTicker() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}
watch(
    () => state.value.countdownEndsAt,
    (endsAt) => {
        if (endsAt) {
            nowMs.value = Date.now();
            if (!ticker) ticker = setInterval(() => (nowMs.value = Date.now()), 100);
        } else {
            stopTicker();
        }
    },
    { immediate: true },
);
onBeforeUnmount(stopTicker);

const countdownMs = computed(() => {
    const endsAt = state.value.countdownEndsAt;
    if (!endsAt) return null;
    return Math.max(0, endsAt - nowMs.value);
});
const countdownSeconds = computed(() =>
    countdownMs.value === null ? '' : (countdownMs.value / 1000).toFixed(1),
);

/** 波形柱高：本机引擎用真实 RMS；浏览器引擎没有电平，用 CSS 呼吸动画。 */
const BAR_FACTORS = [0.55, 0.85, 1, 0.78, 0.5];
function barStyle(index) {
    if (!listening.value) return { transform: 'scaleY(0.18)' };
    if (browserEngine.value) return {};
    const base = Math.min(1, 0.18 + state.value.level * 6);
    return { transform: `scaleY(${(0.3 + BAR_FACTORS[index] * base * 0.7).toFixed(2)})` };
}

const percent = computed(() =>
    Math.round(Math.min(1, Math.max(0, state.value.downloadProgress)) * 100),
);

function cancelAndEdit() {
    props.controller.cancelCountdown();
}
</script>

<template>
    <div v-if="visible" class="voice-bar">
        <!-- 首次浏览器云识别确认（明确告知音频会发送给浏览器厂商） -->
        <div v-if="consentRequired" class="voice-card consent" role="dialog" aria-label="浏览器识别确认">
            <div class="voice-card-title">
                <LineIcon name="mic" size="14" />
                浏览器识别需要确认
            </div>
            <p class="voice-card-text">
                当前将使用浏览器内置语音识别，<strong>音频可能会发送给浏览器厂商（云端）</strong>。
                安装本机语音模型后，音频只在本机处理，更私密。
            </p>
            <div class="voice-card-actions">
                <button type="button" class="voice-btn-primary" @click="controller.grantBrowserConsent()">
                    同意并启用浏览器识别
                </button>
                <button type="button" class="voice-btn-secondary" @click="controller.installModel()">
                    安装本机模型（约 48MB）
                </button>
                <button type="button" class="voice-btn-text" @click="controller.declineBrowserConsent()">
                    仅用文字
                </button>
            </div>
            <div v-if="state.installing" class="voice-install">
                <div class="voice-progress" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
                    <span :style="{ width: `${percent}%` }"></span>
                </div>
                <span>正在下载本机语音模型… {{ percent }}%</span>
            </div>
            <div v-else-if="state.downloadError" class="voice-error-inline">{{ state.downloadError }}</div>
        </div>

        <template v-else>
            <div class="voice-status-row">
                <span class="voice-indicator" :class="{ listening, paused: phase === 'paused', error: phase === 'error' }" aria-hidden="true"></span>
                <span
                    class="voice-wave"
                    :class="{ active: listening, browser: browserEngine && listening }"
                    aria-hidden="true"
                >
                    <span v-for="r in 5" :key="r" :style="barStyle(r - 1)"></span>
                </span>
                <span class="voice-status-text" aria-live="polite">{{ statusText }}</span>
                <span
                    v-if="engineBadge"
                    class="voice-engine-badge"
                    :class="{ cloud: state.engine === 'browser-cloud' }"
                >
                    {{ engineBadge }}
                </span>

                <!-- 自动发送倒计时 chip -->
                <span v-if="countdownMs !== null" class="voice-countdown" role="status">
                    <span class="voice-countdown-time">{{ countdownSeconds }}s 后发送</span>
                    <button type="button" class="voice-chip-btn" aria-label="取消自动发送" @click="controller.cancelCountdown()">
                        取消
                    </button>
                    <button type="button" class="voice-chip-btn" aria-label="取消自动发送并编辑" @click="cancelAndEdit">
                        编辑
                    </button>
                </span>

                <span class="voice-actions">
                    <button
                        v-if="canResume"
                        type="button"
                        class="voice-action"
                        :aria-label="state.tabConflict ? '接管语音输入' : '恢复语音输入'"
                        @click="state.tabConflict ? controller.takeOver() : controller.resume()"
                    >
                        {{ state.tabConflict ? '接管' : '恢复' }}
                    </button>
                    <button
                        v-if="canPause"
                        type="button"
                        class="voice-action"
                        aria-label="暂停语音输入"
                        @click="controller.pause('manual')"
                    >
                        暂停
                    </button>
                </span>
            </div>

            <div v-if="state.notice" class="voice-notice" role="status">{{ state.notice }}</div>

            <!-- 本机模型安装入口（浏览器降级时仍可升级为更私密的本机识别） -->
            <div v-if="showInstallHint || showModelCard" class="voice-model-row">
                <template v-if="state.installing">
                    <div class="voice-progress" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
                        <span :style="{ width: `${percent}%` }"></span>
                    </div>
                    <span class="voice-model-text">正在下载本机语音模型… {{ percent }}%</span>
                </template>
                <template v-else>
                    <span class="voice-model-text">
                        <template v-if="state.downloadError">{{ state.downloadError }}</template>
                        <template v-else-if="showInstallHint">本机识别不可用，当前为浏览器识别。</template>
                        <template v-else>首次使用需安装本机语音模型（约 48MB，音频不会上传）。</template>
                    </span>
                    <button type="button" class="voice-btn-secondary" aria-label="安装本机语音模型" @click="controller.installModel()">
                        {{ state.downloadError ? '重试安装' : '安装本机模型' }}
                    </button>
                </template>
                <button
                    v-if="state.downloadError || (phase === 'error' && !state.installing)"
                    type="button"
                    class="voice-btn-text"
                    @click="controller.disable()"
                >
                    仅用文字
                </button>
            </div>

            <!-- 非模型类错误：重试 / 降级文字 -->
            <div
                v-if="phase === 'error' && !showModelCard"
                class="voice-card error"
                role="alert"
            >
                <span class="voice-error-text">{{ state.error?.message || '语音输入不可用' }}</span>
                <button type="button" class="voice-btn-secondary" @click="controller.toggle()">重试</button>
                <button type="button" class="voice-btn-text" @click="controller.disable()">切换文字输入</button>
            </div>

            <!-- 多标签页只读提示 -->
            <div v-if="state.tabConflict && phase === 'paused'" class="voice-card tab-conflict" role="status">
                <span>另一标签页正在使用语音输入。</span>
                <button type="button" class="voice-btn-secondary" @click="controller.takeOver()">接管</button>
            </div>
        </template>
    </div>
</template>

<style scoped>
.voice-bar {
    max-width: 760px;
    margin: 0 auto 4px;
    width: 100%;
    padding: 0 16px;
    box-sizing: border-box;
}
.voice-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    padding: 10px 12px;
    margin-bottom: 6px;
    box-shadow: var(--shadow-sm);
}
.voice-card.consent {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.voice-card.error {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    border-color: rgba(239, 68, 68, 0.4);
}
.voice-card.tab-conflict {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.voice-card-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
}
.voice-card-text {
    margin: 6px 0 8px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-secondary);
}
.voice-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.voice-btn-primary,
.voice-btn-secondary {
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--fg);
}
.voice-btn-primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
}
.voice-btn-primary:hover {
    background: var(--accent-hover);
}
.voice-btn-secondary:hover {
    border-color: var(--accent);
    color: var(--accent);
}
.voice-btn-text {
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
    padding: 4px;
}
.voice-btn-text:hover {
    color: var(--fg);
}
.voice-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    font-size: 12px;
    color: var(--fg-secondary);
    min-height: 24px;
}
.voice-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    flex: none;
}
.voice-indicator.listening {
    background: #22c55e;
}
.voice-indicator.paused {
    background: #f59e0b;
}
.voice-indicator.error {
    background: #ef4444;
}
.voice-wave {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 16px;
    flex: none;
}
.voice-wave > span {
    width: 3px;
    height: 16px;
    border-radius: 2px;
    background: var(--accent);
    transform-origin: center;
    transition: transform 0.08s linear;
    opacity: 0.7;
}
.voice-wave:not(.active) > span {
    transform: scaleY(0.18);
    opacity: 0.35;
}
.voice-wave.browser > span {
    animation: voice-breathe 1.2s ease-in-out infinite;
}
.voice-wave.browser > span:nth-child(2) {
    animation-delay: 0.1s;
}
.voice-wave.browser > span:nth-child(3) {
    animation-delay: 0.2s;
}
.voice-wave.browser > span:nth-child(4) {
    animation-delay: 0.3s;
}
.voice-wave.browser > span:nth-child(5) {
    animation-delay: 0.4s;
}
.voice-wave.browser > span:nth-child(1) {
    animation-delay: 0.05s;
}
@keyframes voice-breathe {
    0%, 100% { transform: scaleY(0.25); }
    50% { transform: scaleY(0.95); }
}
.voice-status-text {
    color: var(--fg-secondary);
    white-space: nowrap;
}
.voice-engine-badge {
    font-size: 11px;
    color: var(--fg-tertiary);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    padding: 1px 7px;
    white-space: nowrap;
}
.voice-engine-badge.cloud {
    color: #b45309;
    border-color: rgba(180, 83, 9, 0.35);
    background: rgba(217, 119, 6, 0.08);
}
.voice-countdown {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-text, var(--accent));
    font-size: 11px;
}
.voice-countdown-time {
    font-variant-numeric: tabular-nums;
}
.voice-chip-btn {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    cursor: pointer;
    padding: 0 2px;
    text-decoration: underline;
}
.voice-actions {
    margin-left: auto;
    display: flex;
    gap: 6px;
}
.voice-action {
    padding: 2px 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-panel);
    color: var(--fg-secondary);
    font-size: 11px;
    cursor: pointer;
}
.voice-action:hover {
    color: var(--accent);
    border-color: var(--accent);
}
.voice-notice {
    font-size: 11px;
    color: var(--fg-tertiary);
    padding: 0 2px 2px;
}
.voice-model-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 2px 2px 4px;
}
.voice-model-text {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.voice-error-inline {
    margin-top: 6px;
    font-size: 11px;
    color: #ef4444;
}
.voice-error-text {
    flex: 1;
    min-width: 160px;
    color: #ef4444;
    font-size: 12px;
}
.voice-progress {
    width: 120px;
    height: 4px;
    border-radius: 999px;
    background: var(--bg-hover);
    overflow: hidden;
    flex: none;
}
.voice-progress > span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
}
@media (prefers-reduced-motion: reduce) {
    .voice-wave > span,
    .voice-wave.browser > span {
        animation: none;
        transition: none;
    }
    .voice-progress > span {
        transition: none;
    }
}
</style>
