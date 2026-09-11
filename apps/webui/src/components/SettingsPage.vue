<script setup>
import { ref, watch } from 'vue';
import { LOOP_MODES, PERMISSION_LEVELS, PERMISSION_META } from '../scripts/goal-contract.ts';
import { runSettings, saveRunSettings } from '../scripts/run-settings.ts';

/** Update one run-default field and persist it. */
function updateRun(key, value) {
    saveRunSettings({ [key]: value });
}

function permissionLabel(level) {
    return PERMISSION_META[level]?.label || level;
}
function permissionHint(level) {
    return PERMISSION_META[level]?.hint || '';
}

const props = defineProps({
    activeTab: { type: String, default: 'general' },
    theme: { type: String, default: 'system' },
    cfg: { type: Object, default: null },
    selectedModel: { type: String, default: '' },
    reasoningLevel: { type: String, default: 'high' },
    reasoningLevels: { type: Array, default: () => ['low', 'medium', 'high'] },
    syncing: { type: Boolean, default: false },
    /** 随心聊默认工作区（后端配置）。 */
    freeChatWorkspace: { type: String, default: '' },
    /** 系统级权限 grant（后端 settings.json 持久化）。 */
    permissionCeiling: { type: String, default: 'read-only' },
});
const emit = defineEmits([
    'update:theme',
    'update:selectedModel',
    'update:reasoningLevel',
    'sync-models',
    'save-free-workspace',
    'pick-free-workspace',
    'save-permission',
]);

const freeChatDraft = ref(props.freeChatWorkspace);
watch(
    () => props.freeChatWorkspace,
    (value) => {
        freeChatDraft.value = value;
    },
);
</script>

<template>
    <div class="settings-page">
        <!-- General -->
        <template v-if="activeTab === 'general'">
            <h1 class="settings-title">General</h1>
            <div class="settings-group">
                <div class="settings-group-title">Appearance</div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Theme</div>
                        <div class="setting-desc">UI color theme</div>
                    </div>
                    <select :value="theme" @change="emit('update:theme', $event.target.value)" class="setting-select">
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                        <option value="system">System</option>
                    </select>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-group-title">Workspace</div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Free chat workspace</div>
                        <div class="setting-desc">{{ freeChatWorkspace || '未设置（默认 $MAZI_HOME/workspace）' }}</div>
                    </div>
                    <div class="setting-actions">
                        <input class="setting-input" v-model="freeChatDraft" placeholder="~/.mazi/workspace" />
                        <button class="setting-sync" @click="emit('save-free-workspace', freeChatDraft)">保存</button>
                        <button class="setting-sync" @click="emit('pick-free-workspace')">选择…</button>
                    </div>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-group-title">Run defaults</div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">System permission grant</div>
                        <div class="setting-desc">
                            应用到所有新会话 · {{ permissionHint(permissionCeiling) }}
                        </div>
                    </div>
                    <select
                        class="setting-select"
                        :value="permissionCeiling"
                        @change="emit('save-permission', $event.target.value)"
                    >
                        <option v-for="p in PERMISSION_LEVELS" :key="p" :value="p">
                            {{ permissionLabel(p) }}
                        </option>
                    </select>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Budget (USD)</div>
                        <div class="setting-desc">Spending cap for a new goal</div>
                    </div>
                    <input
                        class="setting-input"
                        type="number"
                        min="0"
                        step="0.1"
                        :value="runSettings.budgetUsd"
                        @change="updateRun('budgetUsd', Number($event.target.value))"
                    />
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Max steps</div>
                        <div class="setting-desc">Upper bound of model steps per task</div>
                    </div>
                    <input
                        class="setting-input"
                        type="number"
                        min="1"
                        step="1"
                        :value="runSettings.maxSteps"
                        @change="updateRun('maxSteps', Number($event.target.value))"
                    />
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Loop mode</div>
                        <div class="setting-desc">Execution loop used for new goals</div>
                    </div>
                    <select
                        class="setting-select"
                        :value="runSettings.loopMode"
                        @change="updateRun('loopMode', $event.target.value)"
                    >
                        <option v-for="m in LOOP_MODES" :key="m.value" :value="m.value">
                            {{ m.label }}
                        </option>
                    </select>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-group-title">Storage</div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Data directory</div>
                        <div class="setting-desc">{{ cfg ? cfg.home : '-' }}</div>
                    </div>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Database</div>
                        <div class="setting-desc">{{ cfg ? `${cfg.storage.driver} · ${cfg.storage.db}` : '-' }}</div>
                    </div>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Events directory</div>
                        <div class="setting-desc">{{ cfg ? cfg.storage.events : '-' }}</div>
                    </div>
                </div>
            </div>
        </template>

        <!-- Model -->
        <template v-else-if="activeTab === 'model'">
            <h1 class="settings-title">Model</h1>
            <div class="settings-group">
                <div class="settings-group-title">Default model</div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Model</div>
                        <div class="setting-desc">Default model for new sessions</div>
                    </div>
                    <select :value="selectedModel" @change="emit('update:selectedModel', $event.target.value)" class="setting-select">
                        <template v-for="p in cfg?.providers || []" :key="p.id">
                            <option v-for="m in p.models || []" :key="m.id" :value="m.id">{{ p.vendor || p.id }} / {{ m.name || m.id }}</option>
                        </template>
                    </select>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Reasoning level</div>
                        <div class="setting-desc">Default reasoning effort</div>
                    </div>
                    <select :value="reasoningLevel" @change="emit('update:reasoningLevel', $event.target.value)" class="setting-select">
                        <option v-for="lvl in reasoningLevels" :key="lvl.value || lvl" :value="lvl.value || lvl">
                            {{ lvl.label || lvl }}
                        </option>
                    </select>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Model catalog</div>
                        <div class="setting-desc">Sync the model list from the provider catalog</div>
                    </div>
                    <button class="setting-sync" :disabled="syncing" @click="emit('sync-models')">
                        {{ syncing ? '同步中…' : '同步模型' }}
                    </button>
                </div>
            </div>
        </template>

        <!-- Providers -->
        <template v-else-if="activeTab === 'providers'">
            <h1 class="settings-title">Providers</h1>
            <div class="settings-group">
                <div class="settings-group-title">Configured providers</div>
                <div v-for="p in cfg?.providers || []" :key="p.id" class="setting-item provider-item">
                    <div class="setting-info">
                        <div class="setting-name">{{ p.vendor || p.id }}</div>
                        <div v-for="m in p.models || []" :key="m.id" class="model-meta">
                            <span class="model-id">{{ m.name || m.id }}</span>
                            <span v-if="m.contextWindow" class="model-tag">{{ Math.round(m.contextWindow / 1000) }}K ctx</span>
                            <span v-if="m.capabilities?.supportsReasoning" class="model-tag">reasoning</span>
                            <span v-if="m.capabilities?.supportsVision" class="model-tag">vision</span>
                            <span v-if="m.pricing?.inputPerMTok != null" class="model-tag">${{ m.pricing.inputPerMTok }}/M in</span>
                            <span v-if="m.pricing?.outputPerMTok != null" class="model-tag">${{ m.pricing.outputPerMTok }}/M out</span>
                        </div>
                        <div v-if="!(p.models || []).length" class="setting-desc">No models</div>
                    </div>
                    <span class="setting-badge ok">configured</span>
                </div>
                <div v-if="!cfg?.providers?.length" class="setting-empty">No providers configured. Add API keys in ~/.mazi/providers.json</div>
            </div>
        </template>

        <!-- About -->
        <template v-else-if="activeTab === 'about'">
            <h1 class="settings-title">About</h1>
            <div class="settings-group">
                <div class="settings-group-title">Application</div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">mazi</div>
                        <div class="setting-desc">Goal-oriented agent runtime</div>
                    </div>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Config location</div>
                        <div class="setting-desc">~/.mazi (providers.json, tools.json)</div>
                    </div>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Session storage</div>
                        <div class="setting-desc">mazi.db (goal_nodes / goal_tasks / goal_steps)</div>
                    </div>
                </div>
            </div>
        </template>
    </div>
</template>

<style scoped>
.settings-page {
    flex: 1;
    padding: 32px 48px;
    overflow-y: auto;
    max-width: 720px;
}
.settings-title {
    font-size: 24px;
    font-weight: 600;
    margin: 0 0 24px;
    color: var(--fg);
}
.settings-group {
    margin-bottom: 28px;
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
    word-break: break-all;
}
.setting-select {
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
}
.setting-sync {
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
}
.setting-sync:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
}
.setting-sync:disabled {
    opacity: 0.6;
    cursor: wait;
}
.setting-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}
.setting-input {
    width: 120px;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 13px;
}
.setting-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
}
.setting-badge.ok {
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
}
.setting-empty {
    padding: 16px 0;
    font-size: 13px;
    color: var(--fg-tertiary);
}
.provider-item {
    align-items: flex-start;
}
.model-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: 12px;
}
.model-id {
    color: var(--fg);
    font-family: ui-monospace, monospace;
}
.model-tag {
    color: var(--fg-secondary);
    background: var(--bg-hover);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
}
</style>
