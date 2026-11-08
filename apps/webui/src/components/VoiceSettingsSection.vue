<script setup>
/**
 * 设置 → Voice 分区（docs/web/语音输入设计.md §9）。
 *
 * 只负责语音输入（ASR）：偏好、暂停规则、浏览器识别同意、本机模型自动安装状态、
 * 诊断（安全上下文 + 测试麦克风电平）。设置写 localStorage（mazi.web.voice-settings）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { AudioCapture, isCaptureSupported, mapCaptureError } from '../voice/capture.ts';
import { detectBrowserAsr } from '../voice/browser-asr.ts';
import {
    fetchVoiceCapabilities,
    fetchVoiceModels,
    toVoiceErrorInfo,
} from '../voice/local-asr.ts';
import { resetVoiceSettings, saveVoiceSettings, voiceSettings } from '../voice/settings.ts';

/** 单项偏好更新（合并写入 + localStorage）。 */
function update(key, value) {
    saveVoiceSettings({ [key]: value });
}
function updateNumber(event, key, min, max) {
    const raw = Number(event.target.value);
    if (!Number.isFinite(raw)) return;
    const value = Math.min(max, Math.max(min, Math.round(raw)));
    saveVoiceSettings({ [key]: value });
}

const idleMinutes = computed(() => Math.round(voiceSettings.pauseAfterIdleMs / 60000));
const sendDelaySeconds = computed(() => (voiceSettings.sendDelayMs / 1000).toFixed(1));

const caps = ref(null);
const models = ref([]);
const capsError = ref('');
const capsLoading = ref(false);
const browserSupported = ref(false);
const browserOnDevice = ref(false);
const notice = ref('');
/** 服务启动时自动安装的本机模型状态（capabilities.install）。 */
const install = ref(null);
let installPollTimer = null;

const micTesting = ref(false);
const micLevel = ref(0);
const micNotice = ref('');
let micCapture = null;

const installedModels = computed(() => models.value.filter((model) => model.installed));
const installRunning = computed(() => install.value?.status === 'running');
const installFailed = computed(() => install.value?.status === 'error');
const installProgress = computed(() => {
    const raw = Number(install.value?.progress ?? 0);
    const normalized = raw > 1 ? raw / 100 : raw;
    return Math.round(Math.min(1, Math.max(0, normalized)) * 100);
});
const engineHint = computed(() => {
    if (voiceSettings.engine === 'local') return '仅本机 sherpa 流式识别；不可用时明确报错并降级文字。';
    if (voiceSettings.engine === 'browser-on-device') return '只使用浏览器 on-device 识别；不可用时明确报错。';
    return 'auto：本机 → 浏览器 on-device → 浏览器云识别（首次需同意）→ 文字输入。';
});
const secureContextText = computed(() => {
    if (typeof window === 'undefined') return '未知';
    return window.isSecureContext ? '是（localhost / HTTPS）' : '否（浏览器禁止麦克风，请改用 localhost 或 HTTPS）';
});
const browserCapabilityText = computed(() => {
    if (!browserSupported.value) return '不支持 Web Speech API';
    return browserOnDevice.value ? '支持（本机语言包可用）' : '支持（无本机语言包，云识别需同意）';
});

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const mb = bytes / 1024 / 1024;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb.toFixed(0)}MB`;
}

async function refresh() {
    capsLoading.value = true;
    capsError.value = '';
    try {
        const capabilities = await fetchVoiceCapabilities();
        caps.value = capabilities;
        models.value = capabilities.models ?? [];
        install.value = capabilities.install ?? null;
    } catch (error) {
        caps.value = null;
        install.value = null;
        capsError.value = toVoiceErrorInfo(error).message || '无法连接本机语音服务';
        try {
            models.value = await fetchVoiceModels();
        } catch {
            models.value = [];
        }
    } finally {
        capsLoading.value = false;
    }
    try {
        const detection = await detectBrowserAsr(voiceSettings.language);
        browserSupported.value = detection.supported;
        browserOnDevice.value = detection.onDevice;
    } catch {
        browserSupported.value = false;
        browserOnDevice.value = false;
    }
    scheduleInstallPoll();
}

/** 自动安装 running 时每 1.5s 轮询 capabilities，直到 done/error。 */
function scheduleInstallPoll() {
    clearInstallPoll();
    if (install.value?.status !== 'running') return;
    installPollTimer = setTimeout(() => {
        installPollTimer = null;
        void refresh();
    }, 1500);
}

function clearInstallPoll() {
    if (installPollTimer !== null) {
        clearTimeout(installPollTimer);
        installPollTimer = null;
    }
}

/** 空闲暂停以分钟展示，存储仍为毫秒。 */
function updateIdleMinutes(event) {
    const minutes = Number(event.target.value);
    if (!Number.isFinite(minutes)) return;
    const ms = Math.min(3_600_000, Math.max(0, Math.round(minutes * 60_000)));
    saveVoiceSettings({ pauseAfterIdleMs: ms });
}

function onResetDefaults() {
    resetVoiceSettings();
    notice.value = '已恢复语音输入默认设置。';
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
    micNotice.value = '';
    if (!isCaptureSupported()) {
        micNotice.value = '当前地址不是安全上下文（需要 localhost 或 HTTPS），浏览器禁止麦克风。';
        return;
    }
    micTesting.value = true;
    micLevel.value = 0;
    try {
        const capture = new AudioCapture();
        micCapture = capture;
        await capture.start({
            deviceId: voiceSettings.inputDeviceId,
            onFrame: (frame) => {
                micLevel.value = frame.level;
            },
        });
    } catch (error) {
        stopMicTest();
        micNotice.value = mapCaptureError(error).message;
    }
}

/** 诊断电平柱高。 */
function meterStyle(index) {
    if (!micTesting.value) return { transform: 'scaleY(0.16)' };
    const factors = [0.5, 0.8, 1, 0.72, 0.45];
    const base = Math.min(1, 0.16 + micLevel.value * 7);
    return { transform: `scaleY(${(0.25 + factors[index] * base * 0.75).toFixed(2)})` };
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
        <div v-if="capsError" class="vs-banner" role="status">
            <span>
                本机语音服务不可用：{{ capsError }}。仍可使用浏览器识别（需同意）或继续用文字输入。
            </span>
            <button type="button" class="vs-btn" @click="refresh">重试连接</button>
        </div>
        <div v-if="notice" class="vs-notice" role="status">{{ notice }}</div>

        <!-- General -->
        <div class="settings-group">
            <div class="settings-group-title">General</div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">启用语音输入</div>
                    <div class="setting-desc">
                        默认开启；未授权前不会自动弹权限。页面可见且获得授权后连续监听，切后台 / 失焦自动暂停。
                    </div>
                </div>
                <label class="vs-switch">
                    <input
                        type="checkbox"
                        :checked="voiceSettings.enabled"
                        aria-label="启用语音输入"
                        @change="update('enabled', $event.target.checked)"
                    />
                    <span class="vs-switch-track" aria-hidden="true"></span>
                </label>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">监听模式</div>
                    <div class="setting-desc">continuous = 连续监听；push-to-talk 为预留项（当前等效手动开关）。</div>
                </div>
                <select class="vs-select" :value="voiceSettings.mode" @change="update('mode', $event.target.value)">
                    <option value="continuous">连续监听（continuous）</option>
                    <option value="push-to-talk">按住说话（预留）</option>
                </select>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">识别引擎</div>
                    <div class="setting-desc">{{ engineHint }}</div>
                </div>
                <select class="vs-select" :value="voiceSettings.engine" @change="update('engine', $event.target.value)">
                    <option value="auto">自动（auto）</option>
                    <option value="local">本机模型（local）</option>
                    <option value="browser-on-device">浏览器 on-device</option>
                </select>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">识别语言</div>
                    <div class="setting-desc">默认中文；本机模型由服务启动时自动安装。</div>
                </div>
                <select class="vs-select" :value="voiceSettings.language" @change="update('language', $event.target.value)">
                    <option value="zh-CN">中文（zh-CN）</option>
                    <option value="en-US">English（en-US）</option>
                </select>
            </div>
        </div>

        <!-- 识别与采集 -->
        <div class="settings-group">
            <div class="settings-group-title">识别与采集</div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">final 后自动发送</div>
                    <div class="setting-desc">{{ sendDelaySeconds }}s 倒计时；打字或继续说话会取消倒计时。</div>
                </div>
                <label class="vs-switch">
                    <input
                        type="checkbox"
                        :checked="voiceSettings.autoSend"
                        aria-label="final 后自动发送"
                        @change="update('autoSend', $event.target.checked)"
                    />
                    <span class="vs-switch-track" aria-hidden="true"></span>
                </label>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">发送倒计时（毫秒）</div>
                    <div class="setting-desc">0–10000；默认 1500。</div>
                </div>
                <input
                    class="vs-input"
                    type="number"
                    min="0"
                    max="10000"
                    step="100"
                    :value="voiceSettings.sendDelayMs"
                    @change="updateNumber($event, 'sendDelayMs', 0, 10000)"
                />
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">端点静音（毫秒）</div>
                    <div class="setting-desc">静音多久判定说完；200–3000，默认 700。</div>
                </div>
                <input
                    class="vs-input"
                    type="number"
                    min="200"
                    max="3000"
                    step="50"
                    :value="voiceSettings.endpointSilenceMs"
                    @change="updateNumber($event, 'endpointSilenceMs', 200, 3000)"
                />
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">静音灵敏度</div>
                    <div class="setting-desc">high 更易触发（嘈杂环境可调低）。</div>
                </div>
                <select class="vs-select" :value="voiceSettings.sensitivity" @change="update('sensitivity', $event.target.value)">
                    <option value="low">低（更抗噪）</option>
                    <option value="normal">正常</option>
                    <option value="high">高（更灵敏）</option>
                </select>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">单句最长时长（毫秒）</div>
                    <div class="setting-desc">1000–60000；到点强制 final。</div>
                </div>
                <input
                    class="vs-input"
                    type="number"
                    min="1000"
                    max="60000"
                    step="1000"
                    :value="voiceSettings.maxUtteranceMs"
                    @change="updateNumber($event, 'maxUtteranceMs', 1000, 60000)"
                />
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">展示 partial</div>
                    <div class="setting-desc">partial 只做灰色 ghost 展示，不写入输入框。</div>
                </div>
                <label class="vs-switch">
                    <input
                        type="checkbox"
                        :checked="voiceSettings.showPartial"
                        aria-label="展示 partial"
                        @change="update('showPartial', $event.target.checked)"
                    />
                    <span class="vs-switch-track" aria-hidden="true"></span>
                </label>
            </div>
        </div>

        <!-- 暂停规则 -->
        <div class="settings-group">
            <div class="settings-group-title">暂停规则</div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">失焦 / 切后台暂停</div>
                    <div class="setting-desc">释放麦克风（系统麦克风指示消失），回到前台后尝试恢复。</div>
                </div>
                <label class="vs-switch">
                    <input
                        type="checkbox"
                        :checked="voiceSettings.pauseOnBlur"
                        aria-label="失焦时暂停语音"
                        @change="update('pauseOnBlur', $event.target.checked)"
                    />
                    <span class="vs-switch-track" aria-hidden="true"></span>
                </label>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">执行中暂停</div>
                    <div class="setting-desc">busy=true 时暂歇，run 结束后自动恢复（不打断执行）。</div>
                </div>
                <label class="vs-switch">
                    <input
                        type="checkbox"
                        :checked="voiceSettings.pauseOnBusy"
                        aria-label="执行中暂停语音"
                        @change="update('pauseOnBusy', $event.target.checked)"
                    />
                    <span class="vs-switch-track" aria-hidden="true"></span>
                </label>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">空闲自动暂停（分钟）</div>
                    <div class="setting-desc">0 = 关闭；默认 10 分钟无语音自动暂停省电。</div>
                </div>
                <input
                    class="vs-input"
                    type="number"
                    min="0"
                    max="60"
                    step="1"
                    :value="idleMinutes"
                    @change="updateIdleMinutes"
                />
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">快捷键</div>
                    <div class="setting-desc">暂停 / 恢复语音；Mod = ⌘（mac）或 Ctrl（其他）。</div>
                </div>
                <input
                    class="vs-input wide"
                    type="text"
                    :value="voiceSettings.shortcut"
                    placeholder="Mod+Shift+M"
                    aria-label="语音快捷键"
                    @change="update('shortcut', $event.target.value.trim() || 'Mod+Shift+M')"
                />
            </div>
        </div>

        <!-- 隐私 -->
        <div class="settings-group">
            <div class="settings-group-title">隐私</div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">允许浏览器识别（可能上传音频）</div>
                    <div class="setting-desc">
                        浏览器 Web Speech 可能把音频发送给浏览器厂商（云端）。默认关闭，只在用户明确同意后启用；
                        本机模型自动安装完成后，音频只在本机处理。
                    </div>
                </div>
                <label class="vs-switch">
                    <input
                        type="checkbox"
                        :checked="voiceSettings.browserConsent"
                        aria-label="允许浏览器识别（可能上传音频）"
                        @change="update('browserConsent', $event.target.checked)"
                    />
                    <span class="vs-switch-track" aria-hidden="true"></span>
                </label>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">浏览器识别能力</div>
                    <div class="setting-desc">{{ browserCapabilityText }}</div>
                </div>
                <span class="vs-badge" :class="{ ok: browserOnDevice }">{{ browserOnDevice ? 'on-device' : 'cloud/unknown' }}</span>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">安全上下文</div>
                    <div class="setting-desc">{{ secureContextText }}</div>
                </div>
                <span class="vs-badge" :class="{ ok: secureContextText.startsWith('是') }">
                    {{ secureContextText.startsWith('是') ? 'secure' : 'insecure' }}
                </span>
            </div>
        </div>

        <!-- 本机模型：服务启动时自动安装，用户无需选择/操作 -->
        <div class="settings-group">
            <div class="settings-group-title">本机模型</div>
            <div v-if="capsError" class="setting-desc">
                无法读取自动安装状态（本机语音服务未启动）。服务恢复后会自动继续。
            </div>
            <template v-else>
                <div v-if="installRunning" class="vs-install-status">
                    <div class="vs-progress" role="progressbar" :aria-valuenow="installProgress" aria-valuemin="0" aria-valuemax="100">
                        <span :style="{ width: `${installProgress}%` }"></span>
                    </div>
                    <span class="setting-desc">本机语音模型自动安装中 {{ installProgress }}%（服务启动时自动安装）</span>
                </div>
                <div v-else-if="installFailed" class="vs-error" role="alert">
                    {{ install?.error || '本机语音模型自动安装失败。' }}
                    <div class="setting-desc">服务下次启动会自动重试；无需手动安装。</div>
                </div>
                <div v-else-if="install?.status === 'done'" class="setting-desc">
                    本机语音模型已就绪（服务启动时自动安装）。
                </div>
                <div v-else class="setting-desc">
                    本机语音模型由服务启动时自动安装，无需手动选择或安装。
                </div>
            </template>
            <div v-if="!models.length && capsLoading" class="setting-desc">读取中…</div>
            <div v-else-if="!models.length && !capsError" class="setting-desc">后端未返回模型信息。</div>
            <div v-for="model in models" :key="model.id" class="vs-model">
                <div class="vs-model-info">
                    <div class="setting-name">
                        {{ model.name }}
                        <span v-if="model.recommended" class="vs-badge ok">默认</span>
                        <span v-if="model.installed" class="vs-badge ok">已安装</span>
                        <span v-else class="vs-badge">待安装</span>
                    </div>
                    <div class="setting-desc">
                        {{ model.description }}
                        <template v-if="formatBytes(model.sizeBytes)"> · {{ formatBytes(model.sizeBytes) }}</template>
                        <template v-if="model.license"> · {{ model.license }}</template>
                        <template v-if="model.languages?.length"> · {{ model.languages.join('/') }}</template>
                    </div>
                </div>
            </div>
            <div class="setting-desc vs-hint">
                模型不提交进仓库，由服务启动时自动下载、校验后原子落盘到本机数据目录；音频不会上传。
            </div>
        </div>

        <!-- 诊断 -->
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
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">本机引擎状态</div>
                    <div class="setting-desc">
                        <template v-if="capsLoading">读取中…</template>
                        <template v-else-if="caps?.engines?.local?.available">可用（模型 {{ caps.engines.local.modelId || '默认' }}）</template>
                        <template v-else>不可用<template v-if="caps?.engines?.local?.reason">：{{ caps.engines.local.reason }}</template></template>
                    </div>
                </div>
                <span class="vs-badge" :class="{ ok: caps?.engines?.local?.available }">
                    {{ caps?.engines?.local?.available ? 'ready' : 'unavailable' }}
                </span>
            </div>
            <div class="setting-item">
                <div class="setting-info">
                    <div class="setting-name">已安装模型</div>
                    <div class="setting-desc">
                        {{ installedModels.length ? installedModels.map((model) => model.name).join('、') : '无' }}
                    </div>
                </div>
            </div>
            <div class="vs-hint">
                诊断信息只在本机展示，不上报；不记录音频与转写文本。
            </div>
        </div>

        <div class="vs-footer">
            <button type="button" class="vs-btn" @click="refresh" :disabled="capsLoading">刷新状态</button>
            <button type="button" class="vs-btn" @click="onResetDefaults">恢复默认</button>
        </div>
    </div>
</template>

<style scoped>
.voice-settings {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.vs-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border: 1px solid rgba(217, 119, 6, 0.35);
    border-radius: 8px;
    background: rgba(217, 119, 6, 0.08);
    font-size: 12px;
    color: var(--fg-secondary);
    margin-bottom: 8px;
}
.vs-notice {
    font-size: 12px;
    color: #22c55e;
    padding: 2px 0 6px;
}
.settings-group {
    margin-bottom: 16px;
    padding: 14px 16px;
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    background: var(--bg-panel);
}
.settings-group-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
    margin-bottom: 8px;
}
.setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--border-soft);
    gap: 16px;
}
.setting-item:last-child {
    border-bottom: none;
}
.setting-info {
    flex: 1;
    min-width: 0;
}
.setting-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg);
}
.setting-desc {
    font-size: 12px;
    color: var(--fg-secondary);
    margin-top: 2px;
    word-break: break-word;
}
.vs-select,
.vs-input {
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
}
.vs-input {
    width: 110px;
}
.vs-input.wide {
    width: 180px;
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
.vs-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
}
.vs-btn:disabled {
    opacity: 0.6;
    cursor: wait;
}
.vs-btn.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
}
.vs-btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
}
.vs-switch {
    position: relative;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    flex: none;
}
.vs-switch input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
}
.vs-switch-track {
    width: 34px;
    height: 20px;
    border-radius: 999px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    transition: background 0.12s, border-color 0.12s;
    position: relative;
}
.vs-switch-track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    transition: transform 0.12s, background 0.12s;
}
.vs-switch input:checked + .vs-switch-track {
    background: var(--accent-soft);
    border-color: var(--accent);
}
.vs-switch input:checked + .vs-switch-track::after {
    transform: translateX(14px);
    background: var(--accent);
}
.vs-switch input:focus-visible + .vs-switch-track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}
.vs-badge {
    font-size: 11px;
    padding: 1px 8px;
    border-radius: 10px;
    background: var(--bg-hover);
    color: var(--fg-secondary);
    white-space: nowrap;
}
.vs-badge.ok {
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
}
.vs-model {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-soft);
}
.vs-model:last-of-type {
    border-bottom: none;
}
.vs-model-info {
    flex: 1;
    min-width: 0;
}
.vs-install-status {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 0 8px;
}
.vs-progress {
    width: 140px;
    height: 4px;
    border-radius: 999px;
    background: var(--bg-hover);
    overflow: hidden;
}
.vs-progress > span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
}
.vs-error {
    margin-top: 8px;
    font-size: 12px;
    color: #ef4444;
}
.vs-hint {
    font-size: 11px;
    color: var(--fg-tertiary);
    margin-top: 6px;
}
.vs-diagnostic {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: none;
}
.vs-meter {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 20px;
}
.vs-meter > span {
    width: 4px;
    height: 20px;
    border-radius: 2px;
    background: var(--accent);
    transform-origin: center;
    transition: transform 0.08s linear;
    opacity: 0.45;
}
.vs-meter.active > span {
    opacity: 0.85;
}
.vs-footer {
    display: flex;
    gap: 8px;
    padding: 4px 0 12px;
}
@media (prefers-reduced-motion: reduce) {
    .vs-switch-track,
    .vs-switch-track::after,
    .vs-progress > span,
    .vs-meter > span {
        transition: none;
    }
}
</style>
