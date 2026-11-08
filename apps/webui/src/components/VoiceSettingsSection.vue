<script setup>
/**
 * 设置 → Voice：本机语音输入（仅本地 ASR）。
 *
 * 不做浏览器识别 / 云端识别，也不做自动发送：
 * 点击麦克风开始，再点停止，识别文字直接写入输入框，然后手动发送。
 * 本机模型由 API 服务启动时自动安装；这里只展示状态与做麦克风诊断。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { AudioCapture, isCaptureSupported, mapCaptureError } from '../voice/capture.ts';
import { fetchVoiceCapabilities, toVoiceErrorInfo } from '../voice/local-asr.ts';

const caps = ref(null);
const loading = ref(false);
const capsError = ref('');
const install = ref(null);
let installPoll = null;

const micTesting = ref(false);
const micLevel = ref(0);
const micNotice = ref('');
let micCapture = null;

const secureContext = computed(() => {
    if (typeof window === 'undefined') return false;
    return Boolean(window.isSecureContext);
});
const secureText = computed(() =>
    secureContext.value ? '是（localhost / HTTPS）' : '否（浏览器禁止麦克风，请用 localhost 或 HTTPS）',
);
const installRunning = computed(() => install.value?.status === 'running');
const installFailed = computed(() => install.value?.status === 'error');
const installProgress = computed(() => {
    const raw = Number(install.value?.progress ?? 0);
    const normalized = raw > 1 ? raw / 100 : raw;
    return Math.round(Math.min(1, Math.max(0, normalized)) * 100);
});
const model = computed(() => caps.value?.models?.[0] ?? null);
const modelText = computed(() => {
    if (!model.value) return '本机模型信息不可用';
    return model.value.name || model.value.id;
});
const modelSize = computed(() => {
    const bytes = Number(model.value?.sizeBytes ?? 0);
    return bytes > 0 ? `${Math.round(bytes / 1024 / 1024)}MB` : '';
});

function formatError(error) {
    return toVoiceErrorInfo(error).message || '无法连接本机语音服务';
}

async function refresh() {
    loading.value = true;
    capsError.value = '';
    try {
        const capabilities = await fetchVoiceCapabilities();
        caps.value = capabilities;
        install.value = capabilities.install ?? null;
    } catch (error) {
        caps.value = null;
        install.value = null;
        capsError.value = formatError(error);
    } finally {
        loading.value = false;
    }
    scheduleInstallPoll();
}

function scheduleInstallPoll() {
    clearInstallPoll();
    if (!installRunning.value) return;
    installPoll = setTimeout(() => {
        installPoll = null;
        void refresh();
    }, 1500);
}

function clearInstallPoll() {
    if (installPoll !== null) {
        clearTimeout(installPoll);
        installPoll = null;
    }
}

function meterStyle(index) {
    if (!micTesting.value) return { transform: 'scaleY(0.16)' };
    const factor = [0.45, 0.7, 1, 0.75, 0.45][index] ?? 0.5;
    return { transform: `scaleY(${(0.2 + Math.min(1, micLevel.value * 6) * factor * 0.8).toFixed(2)})` };
}

function stopMicTest() {
    micCapture?.stop();
    micCapture = null;
    micTesting.value = false;
    micLevel.value = 0;
}

async function toggleMicTest() {
    if (micTesting.value) {
        stopMicTest();
        return;
    }
    if (!isCaptureSupported()) {
        micNotice.value = secureContext.value
            ? '当前浏览器不支持麦克风采集。'
            : '当前地址不是安全上下文，浏览器禁止麦克风。请用 localhost 或 HTTPS。';
        return;
    }
    micNotice.value = '';
    micTesting.value = true;
    micLevel.value = 0;
    const capture = new AudioCapture();
    try {
        await capture.start({
            onFrame: (frame) => {
                micLevel.value = frame.level;
            },
            onError: (error) => {
                micNotice.value = error.message;
            },
        });
        micCapture = capture;
    } catch (error) {
        micTesting.value = false;
        micNotice.value = mapCaptureError(error).message;
    }
}

onMounted(() => {
    void refresh();
});

onBeforeUnmount(() => {
    clearInstallPoll();
    stopMicTest();
});
</script>

<template>
    <div class="voice-settings">
        <div class="settings-group">
            <div class="settings-group-title">本机识别</div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">识别方式</div>
                    <div class="setting-desc">
                        只使用本机 ASR，不启用浏览器识别或云端识别；音频不会上传。
                    </div>
                </div>
                <span class="vs-badge ok">本机</span>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">安全上下文</div>
                    <div class="setting-desc">{{ secureText }}</div>
                </div>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">使用方式</div>
                    <div class="setting-desc">
                        点击麦克风开始录音，再次点击停止；识别文字会直接填入输入框，然后手动点发送。
                    </div>
                </div>
            </div>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">本机模型（服务启动时自动安装）</div>
            <div v-if="capsError" class="vs-error" role="alert">{{ capsError }}</div>
            <template v-else>
                <div v-if="installRunning" class="vs-install">
                    <div
                        class="vs-progress"
                        role="progressbar"
                        :aria-valuenow="installProgress"
                        aria-valuemin="0"
                        aria-valuemax="100"
                    >
                        <span :style="{ width: installProgress + '%' }"></span>
                    </div>
                    <span class="setting-desc">自动安装中 {{ installProgress }}%</span>
                </div>
                <div v-else-if="installFailed" class="vs-error" role="alert">
                    {{ install?.error || '本机模型自动安装失败。' }}
                    <div class="setting-desc">服务下次启动会自动重试；无需手动安装。</div>
                </div>
                <div v-else-if="install?.status === 'done'" class="setting-desc">
                    已就绪：{{ modelText }}<template v-if="modelSize"> · {{ modelSize }}</template>
                </div>
                <div v-else-if="loading" class="setting-desc">读取状态中…</div>
                <div v-else class="setting-desc">
                    服务启动时自动安装，无需手动选择或安装。
                </div>
            </template>
        </div>

        <div class="settings-group">
            <div class="settings-group-title">诊断</div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">测试麦克风</div>
                    <div class="setting-desc">只显示本机电平，不发送音频、不保存音频。</div>
                </div>
                <div class="vs-diagnostic">
                    <span class="vs-meter" :class="{ active: micTesting }" aria-hidden="true">
                        <span v-for="i in 5" :key="i" :style="meterStyle(i - 1)"></span>
                    </span>
                    <button type="button" class="vs-btn" @click="toggleMicTest">
                        {{ micTesting ? '停止测试' : '测试麦克风' }}
                    </button>
                </div>
            </div>
            <div v-if="micNotice" class="vs-error" role="alert">{{ micNotice }}</div>
        </div>
    </div>
</template>

<style scoped>
.voice-settings {
    display: flex;
    flex-direction: column;
    gap: 20px;
}
.settings-group {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-panel);
    overflow: hidden;
}
.settings-group-title {
    padding: 8px 16px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-secondary);
    background: var(--bg-hover);
    border-bottom: 1px solid var(--border-soft);
}
.setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border-soft);
}
.setting-item:last-child {
    border-bottom: none;
}
.setting-info {
    min-width: 0;
}
.setting-name {
    font-size: 13px;
    color: var(--fg);
}
.setting-desc {
    margin-top: 3px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-tertiary);
}
.vs-badge {
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 11px;
    color: var(--fg-secondary);
    background: var(--bg-hover);
}
.vs-badge.ok {
    color: var(--ok);
    background: var(--ok-soft);
}
.vs-install {
    padding: 12px 16px;
}
.vs-progress {
    height: 5px;
    border-radius: 999px;
    background: var(--bg-hover);
    overflow: hidden;
    margin-bottom: 6px;
}
.vs-progress span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
}
.vs-error {
    margin: 10px 16px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--error);
    background: var(--error-soft);
}
.vs-diagnostic {
    display: flex;
    align-items: center;
    gap: 10px;
}
.vs-meter {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 22px;
}
.vs-meter span {
    width: 3px;
    height: 20px;
    border-radius: 2px;
    background: var(--border);
    transform: scaleY(0.16);
    transform-origin: center;
    transition: transform 0.08s linear, background 0.12s;
}
.vs-meter.active span {
    background: var(--accent);
}
.vs-btn {
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
}
.vs-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
}
</style>
