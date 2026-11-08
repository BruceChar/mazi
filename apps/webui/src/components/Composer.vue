<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import VoiceWaveform from './VoiceWaveform.vue';
import { shouldSubmitOnEnter } from '../scripts/composer-keys.ts';
import { PERMISSION_META } from '../scripts/goal-contract.ts';

const props = defineProps({
    modelValue: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    /** 当前 run 被停止且空闲：展示「继续」入口。 */
    resumable: { type: Boolean, default: false },
    activeConversation: { type: Object, default: null },
    projects: { type: Array, default: () => [] },
    workspaceRoot: { type: String, default: '' },
    cfg: { type: Object, default: null },
    selectedModel: { type: String, default: '' },
    reasoningLevel: { type: String, default: 'high' },
    reasoningLevels: { type: Array, default: () => [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
    /** 当前工作区会话权限（覆盖系统默认）。 */
    permission: { type: String, default: 'read-only' },
    permissionLevels: { type: Array, default: () => [] },
    /** 语音状态机阶段（VoiceController.state.phase）。 */
    voiceState: { type: String, default: 'off' },
    /** 语音是否可用（secure context + 麦克风可采集）。 */
    voiceAvailable: { type: Boolean, default: false },
    /** 语音错误（仅错误时显示一行提示）。 */
    voiceError: { type: String, default: '' },
    /** 录音电平 0..1，用于波形动画。 */
    voiceLevel: { type: Number, default: 0 },
});
const emit = defineEmits([
    'update:modelValue',
    'submit',
    'stop',
    'resume',
    'switch-project',
    'open-system-picker',
    'exit-workspace',
    'update:selectedModel',
    'update:reasoningLevel',
    'update:permission',
    'toggle-voice',
]);

/* Internal UI state */
const workspaceMenu = ref(false);
const permMenu = ref(false);
const pickerType = ref(null); // 'model' | 'reasoning' | null

/** 权限档位展示（中文标签 + 说明），元数据在 goal-contract。 */
function permissionLabel() {
    return PERMISSION_META[props.permission]?.label || props.permission || '权限';
}
function permissionText(level) {
    return PERMISSION_META[level]?.label || level;
}
function permissionHint(level) {
    return PERMISSION_META[level]?.hint || '';
}
function selectPermission(level) {
    emit('update:permission', level);
    permMenu.value = false;
}

/* Computed labels */
function currentModelLabel() {
    for (const p of props.cfg?.providers || []) {
        const m = (p.models || []).find((m) => m.id === props.selectedModel);
        if (m) return m.modelVersion || m.name || m.id;
    }
    return props.selectedModel || 'Model';
}
function reasoningLabel() {
    const r = props.reasoningLevels.find((r) => r.value === props.reasoningLevel);
    return r?.label || props.reasoningLevel || 'Reasoning';
}
/** Human-readable workspace for the picker: project title, else folder name. */
function workspaceLabel() {
    const path = props.workspaceRoot;
    if (!path) return 'No workspace';
    const project = props.projects.find((p) => p.path === path);
    if (project) return project.title;
    const parts = path.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || path;
}

function onInput(e) {
    emit('update:modelValue', e.target.value);
}

/* ---------- Voice input entry: local ASR, click to start/stop ---------- */
const VOICE_ACTIVE_PHASES = ['requesting', 'armed', 'partial', 'finalizing'];
const voiceOn = computed(() => VOICE_ACTIVE_PHASES.includes(props.voiceState));
const voiceErrored = computed(() => props.voiceState === 'error');

function voiceIcon() {
    return 'mic';
}

/* 录音计时与状态文案（底部录音条）。 */
const voiceStartedAt = ref(0);
const voiceNow = ref(Date.now());
let voiceTimer = null;
const voiceCaptureText = computed(() => {
    if (props.voiceState === 'requesting') return '正在准备麦克风…';
    if (props.voiceState === 'finalizing') return '正在转写录音…';
    return '正在录音';
});
const voiceElapsedSeconds = computed(() => {
    if (!voiceStartedAt.value) return 0;
    return Math.max(0, Math.floor((voiceNow.value - voiceStartedAt.value) / 1000));
});
const voiceTimerLabel = computed(() => {
    const total = voiceElapsedSeconds.value;
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
});
function stopVoiceTimer() {
    if (voiceTimer !== null) {
        clearInterval(voiceTimer);
        voiceTimer = null;
    }
}
function startVoiceTimer() {
    if (voiceTimer !== null) return;
    voiceTimer = setInterval(() => {
        voiceNow.value = Date.now();
    }, 250);
}
watch(
    () => props.voiceState,
    (state) => {
        if (state === 'armed') {
            if (!voiceStartedAt.value) voiceStartedAt.value = Date.now();
            voiceNow.value = Date.now();
            startVoiceTimer();
        } else if (state === 'off' || state === 'error') {
            stopVoiceTimer();
            voiceStartedAt.value = 0;
        } else if (state === 'finalizing') {
            stopVoiceTimer();
        }
    },
    { immediate: true },
);
onBeforeUnmount(stopVoiceTimer);
function voiceLabel() {
    if (!props.voiceAvailable) return '语音输入不可用（需要 HTTPS 或 localhost）';
    switch (props.voiceState) {
        case 'requesting':
            return '正在准备麦克风…';
        case 'armed':
            return '正在录音 · 点击停止';
        case 'partial':
            return '正在识别 · 点击停止';
        case 'finalizing':
            return '正在转写录音…';
        case 'error':
            return '录音出错 · 点击重试';
        default:
            return '点击开始录音';
    }
}

/* IME composition: Enter confirms a candidate, it must not submit (docs/webui.md §3.5). */
let composing = false;
let compositionEndedAt = 0;
function onCompositionStart() {
    composing = true;
}
function onCompositionEnd() {
    composing = false;
    compositionEndedAt = Date.now();
}
function onKeydown(e) {
    const submit = shouldSubmitOnEnter({
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.isComposing,
        keyCode: e.keyCode,
        composing,
        compositionEndedAt,
        now: Date.now(),
    });
    if (!submit) return;
    e.preventDefault();
    emit('submit');
}
function selectModel(id) {
    emit('update:selectedModel', id);
    pickerType.value = null;
}
function selectReasoning(lvl) {
    emit('update:reasoningLevel', lvl);
    pickerType.value = null;
}
function doSwitchProject(path) {
    emit('switch-project', path);
    workspaceMenu.value = false;
}
function doOpenSystemPicker() {
    emit('open-system-picker');
    workspaceMenu.value = false;
}
function doExitWorkspace() {
    emit('exit-workspace');
    workspaceMenu.value = false;
}
</script>

<template>
    <div class="input-area">
        <div class="input-wrap">
            <div class="input-composer">
                <div class="input-top">
                    <textarea
                        :value="modelValue"
                        rows="1"
                        placeholder="输入任务…（Enter 发送，Shift+Enter 换行）"
                        @input="onInput"
                        @keydown="onKeydown"
                        @compositionstart="onCompositionStart"
                        @compositionend="onCompositionEnd"
                    ></textarea>
                    <div v-if="voiceError" class="voice-error-line" role="alert">{{ voiceError }}</div>
                </div>
                <!-- 录音中：底部替换为虚线波形条，随电平和时间变化。 -->
                <div v-if="voiceOn" class="voice-capture-row" role="status" aria-live="polite">
                    <button
                        type="button"
                        class="voice-stop-btn"
                        :disabled="voiceState === 'finalizing'"
                        aria-label="停止录音"
                        title="停止录音"
                        @click="emit('toggle-voice')"
                    >
                        <LineIcon name="stop" size="16" />
                    </button>
                    <VoiceWaveform
                        class="voice-capture-wave"
                        :level="voiceLevel"
                        :active="voiceState === 'armed'"
                    />
                    <div class="voice-capture-meta">
                        <span class="voice-capture-text">{{ voiceCaptureText }}</span>
                        <span class="voice-capture-timer">{{ voiceTimerLabel }}</span>
                    </div>
                </div>
                <div v-else class="input-footer">
                    <div class="input-footer-left">
                        <div v-if="!activeConversation" class="ws-picker-wrap">
                            <div v-if="workspaceMenu" class="picker-backdrop" @click="workspaceMenu = false"></div>
                            <button
                                class="ws-btn"
                                :class="{ active: workspaceMenu }"
                                @click="workspaceMenu = !workspaceMenu"
                            >
                                <LineIcon name="folder" size="13" />
                                <span>{{ workspaceLabel() }}</span>
                            </button>
                            <div v-if="workspaceMenu" class="ws-menu">
                                <div class="ws-menu-section">Projects</div>
                                <button
                                    v-for="p in projects"
                                    :key="p.path"
                                    class="ws-menu-item"
                                    :class="{ active: p.path === workspaceRoot }"
                                    @click="doSwitchProject(p.path)"
                                >
                                    <LineIcon name="folder" size="13" />
                                    <span>{{ p.title || p.path }}</span>
                                </button>
                                <div class="ws-menu-divider"></div>
                                <button class="ws-menu-item" @click="doOpenSystemPicker">
                                    <LineIcon name="plus" size="13" />
                                    <span>Open other folder…</span>
                                </button>
                                <button v-if="workspaceRoot" class="ws-menu-item danger" @click="doExitWorkspace">
                                    <LineIcon name="close" size="13" />
                                    <span>Exit workspace</span>
                                </button>
                            </div>
                        </div>
                        <!-- 权限：当前工作区会话（覆盖系统默认；系统默认在 设置→General） -->
                        <div class="ws-picker-wrap">
                            <div v-if="permMenu" class="picker-backdrop" @click="permMenu = false"></div>
                            <button
                                class="ws-btn perm-btn"
                                :class="{ active: permMenu }"
                                title="当前工作区会话权限"
                                @click="permMenu = !permMenu"
                            >
                                <LineIcon name="shield" size="13" />
                                <span>{{ permissionLabel() }}</span>
                            </button>
                            <div v-if="permMenu" class="ws-menu">
                                <div class="ws-menu-section">当前工作区权限</div>
                                <button
                                    v-for="level in permissionLevels"
                                    :key="level"
                                    class="ws-menu-item perm-option"
                                    :class="{ active: level === permission }"
                                    @click="selectPermission(level)"
                                >
                                    <LineIcon name="shield" size="13" />
                                    <span class="perm-option-text">
                                        <span class="perm-option-title">{{ permissionText(level) }}</span>
                                        <span class="perm-option-hint">{{ permissionHint(level) }}</span>
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="input-footer-right">
                        <!-- Model picker -->
                        <div class="picker-wrap">
                            <div v-if="pickerType === 'model'" class="picker-backdrop" @click="pickerType = null"></div>
                            <button
                                class="picker-btn model-btn"
                                :class="{ active: pickerType === 'model' }"
                                title="select model"
                                @click="pickerType = pickerType === 'model' ? null : 'model'"
                            >
                                {{ currentModelLabel() }}
                            </button>
                            <div v-if="pickerType === 'model'" class="picker-panel picker-panel-y">
                                <template v-for="p in cfg?.providers || []" :key="p.id">
                                    <div class="picker-group-title">{{ p.vendor || p.id }}</div>
                                    <div
                                        v-for="m in p.models || []"
                                        :key="m.id"
                                        class="picker-option"
                                        :class="{ active: m.id === selectedModel }"
                                        @click="selectModel(m.id)"
                                    >
                                        {{ m.modelVersion || m.name || m.id }}
                                    </div>
                                </template>
                            </div>
                        </div>
                        <!-- Reasoning picker -->
                        <div class="picker-wrap">
                            <div v-if="pickerType === 'reasoning'" class="picker-backdrop" @click="pickerType = null"></div>
                            <button
                                class="picker-btn reasoning-btn"
                                :class="{ active: pickerType === 'reasoning' }"
                                title="select reasoning level"
                                @click="pickerType = pickerType === 'reasoning' ? null : 'reasoning'"
                            >
                                {{ reasoningLabel() }}
                            </button>
                            <div v-if="pickerType === 'reasoning'" class="picker-panel picker-panel-x">
                                <div
                                    v-for="lvl in reasoningLevels"
                                    :key="lvl.value"
                                    class="picker-option picker-option-x"
                                    :class="{ active: lvl.value === reasoningLevel }"
                                    @click="selectReasoning(lvl.value)"
                                >
                                    {{ lvl.label }}
                                </div>
                            </div>
                        </div>
                        <!-- Resume: current run was stopped, idle again -->
                        <button
                            v-if="resumable && !busy"
                            class="resume"
                            title="继续执行"
                            @click="emit('resume')"
                        >
                            <LineIcon name="play" size="12" />
                            <span>继续</span>
                        </button>
                        <!-- Voice: click to start recording, click again to stop. -->
                        <button
                            type="button"
                            data-voice-toggle
                            class="voice-btn voice-btn-send"
                            :class="{
                                active: voiceOn,
                                error: voiceErrored,
                                unavailable: !voiceAvailable,
                            }"
                            :aria-label="voiceLabel()"
                            :aria-pressed="voiceOn"
                            :title="voiceLabel()"
                            :disabled="!voiceAvailable"
                            @click="emit('toggle-voice')"
                        >
                            <LineIcon :name="voiceIcon()" size="24" />
                            <span v-if="voiceOn" class="voice-live-dot" aria-hidden="true"></span>
                        </button>
                        <!-- Primary: stop while executing, send otherwise -->
                        <button v-if="busy" class="send stop" title="停止" @click="emit('stop')">
                            <LineIcon name="stop" size="14" />
                        </button>
                        <button v-else class="send" title="发送" @click="emit('submit')">
                            <LineIcon name="arrowUp" size="16" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.input-area {
    flex: 0 0 auto;
    padding: 4px 16px 14px;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
}
.input-composer {
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-panel);
    box-shadow: var(--shadow-sm);
    transition: border-color 0.12s, box-shadow 0.12s;
    position: relative;
    z-index: 1;
}
.input-composer:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
}
.input-top textarea {
    width: 100%;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 14px;
    line-height: 1.5;
    padding: 12px 14px 8px;
    resize: none;
    outline: none;
    max-height: 200px;
    font-family: inherit;
}
.input-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px 8px;
    gap: 8px;
}
.input-footer-left {
    display: flex;
    align-items: center;
    gap: 6px;
}
.input-footer-right {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
}
/* Recording capture row: dashed waveform + elapsed time. */
.voice-capture-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 2px 8px 8px;
    padding: 6px 10px;
    min-height: 40px;
    border: 1px dashed var(--accent);
    border-radius: 10px;
    background: var(--accent-soft);
}
.voice-stop-btn {
    flex: none;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}
.voice-stop-btn:hover:not(:disabled) {
    background: var(--accent-hover);
}
.voice-stop-btn:disabled {
    opacity: 0.55;
    cursor: default;
}
.voice-capture-wave {
    flex: 1;
    min-width: 0;
}
.voice-capture-meta {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 8px;
    white-space: nowrap;
}
.voice-capture-text {
    font-size: 12px;
    color: var(--fg-secondary);
}
.voice-capture-timer {
    font-size: 12px;
    color: var(--fg-tertiary);
    font-variant-numeric: tabular-nums;
}
/* Voice input */
.voice-btn {
    position: relative;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
}
.voice-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg);
}
.voice-btn.active {
    color: var(--accent);
    background: var(--accent-soft);
}
.voice-btn.paused {
    color: var(--fg-secondary);
    background: var(--bg-hover);
}
.voice-btn.error {
    color: #ef4444;
}
.voice-btn.unavailable,
.voice-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
/* Send-adjacent microphone: intentionally larger than the send button. */
.voice-btn-send {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    flex: 0 0 auto;
    color: var(--fg-secondary);
}
.voice-btn-send :deep(.line-icon) {
    width: 24px;
    height: 24px;
}
.voice-btn-send.active {
    color: #fff;
    background: var(--accent);
}
.voice-btn-send.active:hover:not(:disabled) {
    color: #fff;
    background: var(--accent-hover);
}
.voice-live-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 2px var(--bg-panel);
    animation: voice-pulse 1.4s ease-in-out infinite;
}
@keyframes voice-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.8); }
}
.voice-error-line {
    padding: 0 14px 8px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--error);
}
@media (prefers-reduced-motion: reduce) {
    .voice-live-dot {
        animation: none;
    }
}
/* Workspace picker */
.ws-picker-wrap {
    position: relative;
}
.ws-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 12px;
    border-radius: 6px;
    cursor: pointer;
}
.ws-btn:hover, .ws-btn.active {
    background: var(--bg-hover);
    color: var(--fg);
}
.ws-menu {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    min-width: 220px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    padding: 6px;
    z-index: 100;
}
.ws-menu-section {
    font-size: 11px;
    color: var(--fg-tertiary);
    padding: 4px 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.ws-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    border-radius: 5px;
    cursor: pointer;
    text-align: left;
}
.ws-menu-item:hover {
    background: var(--bg-hover);
}
.ws-menu-item.active {
    background: var(--accent-soft);
    color: var(--accent);
}
.ws-menu-item.danger {
    color: #ef4444;
}
.ws-menu-item.danger:hover {
    background: rgba(239, 68, 68, 0.1);
}
.ws-menu-divider {
    height: 1px;
    background: var(--border-soft);
    margin: 4px 0;
}
.perm-option {
    align-items: flex-start;
}
.perm-option-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
}
.perm-option-title {
    font-size: 13px;
    line-height: 1.3;
}
.perm-option-hint {
    font-size: 11px;
    line-height: 1.3;
    color: var(--fg-tertiary);
    white-space: normal;
}
.perm-option.active .perm-option-hint {
    color: color-mix(in srgb, var(--accent) 70%, var(--fg-tertiary));
}
/* Model / reasoning pickers */
.picker-wrap {
    position: relative;
}
.picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
}
.picker-btn {
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 12px;
    border-radius: 6px;
    cursor: pointer;
}
.picker-btn:hover, .picker-btn.active {
    background: var(--bg-hover);
    color: var(--fg);
}
.reasoning-btn {
    color: var(--fg-tertiary);
    opacity: 0.7;
}
.picker-panel {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-lg);
    padding: 6px;
    z-index: 100;
    max-height: 300px;
    overflow-y: auto;
}
.picker-panel-y {
    min-width: 200px;
}
.picker-panel-x {
    display: flex;
    gap: 4px;
    padding: 6px;
}
.picker-group-title {
    font-size: 11px;
    color: var(--fg-tertiary);
    padding: 6px 8px 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.picker-option {
    padding: 6px 10px;
    border-radius: 5px;
    font-size: 13px;
    color: var(--fg);
    cursor: pointer;
}
.picker-option:hover {
    background: var(--bg-hover);
}
.picker-option.active {
    background: var(--accent-soft);
    color: var(--accent);
}
.picker-option-x {
    white-space: nowrap;
}
/* Send button */
.send {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: none;
    background: var(--accent);
    color: #ffffff;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.12s;
    line-height: 0;
    padding: 0;
}
.send:hover:not(:disabled) {
    background: var(--accent-hover);
}
.send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
/* Stop while executing; resume when the run was stopped. */
.send.stop {
    background: #ef4444;
}
.send.stop:hover:not(:disabled) {
    background: #dc2626;
}
.resume {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-panel);
    color: var(--fg-secondary);
    font-size: 12px;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.resume:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-soft);
}
</style>
