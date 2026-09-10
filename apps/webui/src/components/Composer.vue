<script setup>
import { ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { shouldSubmitOnEnter } from '../scripts/composer-keys.ts';

const props = defineProps({
    modelValue: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    activeConversation: { type: Object, default: null },
    projects: { type: Array, default: () => [] },
    workspaceRoot: { type: String, default: '' },
    cfg: { type: Object, default: null },
    selectedModel: { type: String, default: '' },
    reasoningLevel: { type: String, default: 'high' },
    reasoningLevels: { type: Array, default: () => [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] },
});
const emit = defineEmits([
    'update:modelValue',
    'submit',
    'switch-project',
    'open-system-picker',
    'exit-workspace',
    'update:selectedModel',
    'update:reasoningLevel',
]);

/* Internal UI state */
const workspaceMenu = ref(false);
const pickerType = ref(null); // 'model' | 'reasoning' | null

/* Computed labels */
function currentModelLabel() {
    for (const p of props.cfg?.providers || []) {
        const m = (p.models || []).find((m) => m.id === props.selectedModel);
        if (m) return m.name || m.id;
    }
    return props.selectedModel || 'Model';
}
function reasoningLabel() {
    const r = props.reasoningLevels.find((r) => r.value === props.reasoningLevel);
    return r?.label || props.reasoningLevel || 'Reasoning';
}

function onInput(e) {
    emit('update:modelValue', e.target.value);
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
                </div>
                <div class="input-footer">
                    <div class="input-footer-left">
                        <div v-if="!activeConversation" class="ws-picker-wrap">
                            <div v-if="workspaceMenu" class="picker-backdrop" @click="workspaceMenu = false"></div>
                            <button
                                class="ws-btn"
                                :class="{ active: workspaceMenu }"
                                @click="workspaceMenu = !workspaceMenu"
                            >
                                <LineIcon name="folder" size="13" />
                                <span>No workspace</span>
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
                                        {{ m.name || m.id }}
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
                        <!-- Send button -->
                        <button class="send" :disabled="busy" title="发送" @click="emit('submit')">
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
</style>
