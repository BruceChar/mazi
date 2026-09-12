<script setup>
import { computed, reactive, ref, watch } from 'vue';
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

/** 价目展示：货币符号 / 单价 / 分时倍率（空闲=base，高峰=base×multiplier）。 */
function priceSymbol(currency) {
    return currency === 'CNY' ? '¥' : '$';
}
function fmtPrice(value, currency) {
    if (value == null || !Number.isFinite(Number(value))) return '-';
    const fixed = Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return priceSymbol(currency) + fixed;
}
function hasRate(pricing, key) {
    return pricing?.base?.[key] != null;
}
function priceOf(pricing, key, multiplier) {
    const base = pricing?.base?.[key];
    if (base == null) return '-';
    return fmtPrice(base * (multiplier ?? 1), pricing.currency);
}
/**
 * 分时倍率档位：同名同倍率的多个时段合并为一档（避免价格重复展示），
 * 但保留所有时段（如「周一至周五 09:00–12:00、14:00–18:00」）。
 */
function pricingTiers(pricing) {
    const groups = [];
    for (const tier of pricing?.tiers || []) {
        const key = tier.name + ':' + tier.multiplier;
        let group = groups.find((item) => item.key === key);
        if (!group) {
            group = { key, name: tier.name, multiplier: tier.multiplier, windows: [] };
            groups.push(group);
        }
        const window = tierWindow(tier);
        if (window && !group.windows.includes(window)) group.windows.push(window);
    }
    return groups;
}
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const TIER_LABELS = { peak: '高峰', 'off-peak': '低谷', idle: '空闲' };
function tierLabel(tier) {
    return TIER_LABELS[tier?.name] || tier?.name || '分时';
}
/** 星期集合 → 文案（周一至周五 / 每天 / 列举）。 */
function weekdayLabel(days) {
    if (!Array.isArray(days) || days.length === 0) return '每天';
    const sorted = [...days].sort((a, b) => a - b);
    const isWeekdays =
        sorted.length === 5 && sorted.every((day, index) => day === index + 1);
    if (isWeekdays) return '周一至周五';
    return sorted.map((day) => WEEKDAY_NAMES[day] || `周${day}`).join('、');
}
/** UTC 小时 → 本地 HH:MM（价目档位的时段来自入库的 UTC window）。 */
function fmtHourLocal(hour) {
    const offset = -new Date().getTimezoneOffset() / 60;
    const value = (((hour + offset) % 24) + 24) % 24;
    const hh = Math.floor(value);
    const mm = Math.round((value - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
/** 档位时段文案：`周一至周五 09:00–12:00`。 */
function tierWindow(tier) {
    const window = tier?.windowHoursUtc;
    if (!Array.isArray(window) || window.length !== 2) return '';
    return `${weekdayLabel(tier.weekdays)} ${fmtHourLocal(window[0])}–${fmtHourLocal(window[1])}`;
}
/** 最近同步状态文案。 */
function syncStateText(state) {
    if (!state) return '';
    if (state.lastError) return `上次失败：${state.lastError}`;
    if (state.lastSyncedAt) {
        const at = new Date(state.lastSyncedAt);
        const pad = (n) => String(n).padStart(2, '0');
        return `已同步 ${state.models ?? 0} 档 · ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }
    return '';
}

const props = defineProps({
    activeTab: { type: String, default: 'general' },
    theme: { type: String, default: 'system' },
    cfg: { type: Object, default: null },
    selectedModel: { type: String, default: '' },
    reasoningLevel: { type: String, default: 'high' },
    reasoningLevels: { type: Array, default: () => ['low', 'medium', 'high'] },
    syncing: { type: Boolean, default: false },
    /** 官网价目抓取中（Providers → Pricing 更新按钮）。 */
    pricingSyncing: { type: Boolean, default: false },
    /** 随心聊默认工作区（后端配置）。 */
    freeChatWorkspace: { type: String, default: '' },
    /** 系统级权限 grant（后端 settings.json 持久化）。 */
    permissionCeiling: { type: String, default: 'read-only' },
    /** @deprecated 旧版单一价目源；改用 pricingSources。 */
    pricingSourceUrl: { type: String, default: '' },
    /** 各 vendor 的官方价目源：vendor → URL（后端 settings.json 持久化）。 */
    pricingSources: { type: Object, default: () => ({}) },
    /** 各 vendor 最近同步状态：vendor → { lastSyncedAt, lastError, models }。 */
    pricingSyncState: { type: Object, default: () => ({}) },
    /** provider id → 已配置 API Key 的遮蔽形态（中间隐私；明文不回显）。 */
    apiKeyMasked: { type: Object, default: () => ({}) },
    /** provider id → 实际生效的 Key 来源（configured / env / none）。 */
    apiKeySource: { type: Object, default: () => ({}) },
});
const emit = defineEmits([
    'update:theme',
    'update:selectedModel',
    'update:reasoningLevel',
    'sync-models',
    'save-free-workspace',
    'pick-free-workspace',
    'save-permission',
    'save-pricing-source',
    'refresh-pricing',
    'save-api-key',
]);

/** 各 vendor 的价目源草稿（编辑中；保存后由 cfg 刷新覆盖）。 */
const pricingDrafts = reactive({});
watch(
    () => props.pricingSources,
    (sources) => {
        for (const [vendor, url] of Object.entries(sources || {})) {
            pricingDrafts[vendor] = url || '';
        }
    },
    { immediate: true, deep: true },
);

/** 各 provider 的 API Key 草稿（编辑中；保存后清空，明文不回填）。 */
const apiKeyDrafts = reactive({});
/** 保存/清除某 provider 的 API Key（clear=true 传空串清除）。 */
function saveApiKey(providerId, clear) {
    const value = clear ? '' : apiKeyDrafts[providerId] || '';
    emit('save-api-key', providerId, value);
    apiKeyDrafts[providerId] = '';
}

/** 按 vendor 分组（同一 vendor 的多个 provider 归一组，价目源在 vendor 层配置）。 */
const vendorGroups = computed(() => {
    const groups = new Map();
    for (const provider of props.cfg?.providers || []) {
        const vendor = provider.vendor || provider.id;
        if (!groups.has(vendor)) {
            groups.set(vendor, { vendor, providers: [] });
        }
        groups.get(vendor).providers.push(provider);
    }
    return [...groups.values()];
});

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
                        <div class="setting-name">Default permission grant</div>
                        <div class="setting-desc">
                            只对新工作区会话生效；已有工作区在输入框改过或用过之后不再受影响 ·
                            {{ permissionHint(permissionCeiling) }}
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

        <!-- Providers：按 vendor 分组，价目源配置在 vendor 下 -->
        <template v-else-if="activeTab === 'providers'">
            <h1 class="settings-title">Providers</h1>
            <div v-for="group in vendorGroups" :key="group.vendor" class="settings-group">
                <div class="vendor-head">
                    <div class="settings-group-title">{{ group.vendor }}</div>
                    <span v-if="group.providers.length > 1" class="setting-badge soft">{{ group.providers.length }} providers</span>
                </div>
                <div class="setting-item">
                    <div class="setting-info">
                        <div class="setting-name">Official pricing source</div>
                        <div class="setting-desc">
                            该 vendor 的官方价目页：启动与每 5 分钟抓取，解析分时价目覆盖目录价（空 = 关闭）
                            <template v-if="syncStateText(pricingSyncState[group.vendor])"> · {{ syncStateText(pricingSyncState[group.vendor]) }}</template>
                        </div>
                    </div>
                    <div class="setting-actions">
                        <input
                            class="setting-input wide"
                            v-model="pricingDrafts[group.vendor]"
                            placeholder="https://…/pricing"
                            :title="pricingDrafts[group.vendor]"
                        />
                        <button class="setting-sync" @click="emit('save-pricing-source', group.vendor, pricingDrafts[group.vendor])">保存</button>
                        <button class="setting-sync" :disabled="pricingSyncing" @click="emit('refresh-pricing', group.vendor)">
                            {{ pricingSyncing ? '更新中…' : '更新价格' }}
                        </button>
                    </div>
                </div>
                <div v-for="p in group.providers" :key="p.id" class="setting-item provider-item">
                    <div class="setting-info">
                        <div class="setting-name">{{ p.id }}<span v-if="p.vendor && p.vendor !== p.id" class="setting-name-sub"> · {{ p.vendor }}</span></div>
                        <div v-for="m in p.models || []" :key="m.id" class="model-block">
                            <div class="model-meta">
                                <span class="model-id">{{ m.name || m.id }}</span>
                                <span v-if="m.contextWindow" class="model-tag">{{ Math.round(m.contextWindow / 1000) }}K ctx</span>
                                <span v-if="m.capabilities?.supportsReasoning" class="model-tag">reasoning</span>
                                <span v-if="m.capabilities?.supportsVision" class="model-tag">vision</span>
                                <span v-if="m.pricing?.version" class="model-tag">{{ m.pricing.version }}</span>
                            </div>
                            <div v-if="m.pricing" class="model-price">
                                <span class="price-badge idle">
                                    空闲（其余时段） · in {{ priceOf(m.pricing, 'inputPerMTok') }}
                                    <template v-if="hasRate(m.pricing, 'cacheReadPerMTok')"> · cached {{ priceOf(m.pricing, 'cacheReadPerMTok') }}</template>
                                    · out {{ priceOf(m.pricing, 'outputPerMTok') }}
                                </span>
                                <span
                                    v-for="t in pricingTiers(m.pricing)"
                                    :key="t.key"
                                    class="price-badge peak"
                                >
                                    {{ tierLabel(t) }} ×{{ t.multiplier }}
                                    <template v-if="t.windows.length"> · {{ t.windows.join('、') }}</template>
                                    · in {{ priceOf(m.pricing, 'inputPerMTok', t.multiplier) }}
                                    · out {{ priceOf(m.pricing, 'outputPerMTok', t.multiplier) }}
                                </span>
                            </div>
                            <div v-else class="setting-desc">未配置价目</div>
                        </div>
                        <div v-if="!(p.models || []).length" class="setting-desc">No models</div>
                        <!-- API Key：写入 secrets.json（0600）；明文不回显 -->
                        <div class="provider-apikey">
                            <span class="provider-apikey-label">API Key</span>
                            <input
                                class="setting-input wide"
                                type="password"
                                autocomplete="off"
                                v-model="apiKeyDrafts[p.id]"
                                :placeholder="apiKeyMasked[p.id] ? '已配置（输入可覆盖）' : 'sk-…'"
                            />
                            <button class="setting-sync" @click="saveApiKey(p.id, false)">保存</button>
                            <button v-if="apiKeyMasked[p.id]" class="setting-sync" @click="saveApiKey(p.id, true)">清除</button>
                        </div>
                        <div class="setting-desc">
                            <template v-if="apiKeyMasked[p.id]">
                                已配置：<span class="apikey-masked" title="出于安全，完整 Key 不回显">{{ apiKeyMasked[p.id] }}</span>
                                <span class="apikey-source" :class="apiKeySource[p.id]">
                                    · 模型使用：{{ apiKeySource[p.id] === 'configured' ? '此 Key' : apiKeySource[p.id] === 'env' ? '环境变量' : '无' }}
                                </span>
                            </template>
                            <template v-else-if="apiKeySource[p.id] === 'env'">未配置；当前使用环境变量 {{ p.apiKeyEnv || 'DEEPSEEK_API_KEY' }}</template>
                            <template v-else>未配置（无可用 Key）</template>
                        </div>
                    </div>
                    <span class="setting-badge ok">configured</span>
                </div>
            </div>
            <div v-if="!vendorGroups.length" class="setting-empty">No providers configured. Add API keys in ~/.mazi/providers.json</div>
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
/* 价目源 / API Key：加长输入框；超长文本截断，hover（title）显示完整信息。 */
.setting-input.wide {
    width: 300px;
    max-width: 48vw;
    min-width: 0;
    text-overflow: ellipsis;
}
.apikey-masked {
    font-family: ui-monospace, monospace;
    color: var(--fg-secondary);
    letter-spacing: 0.02em;
}
.apikey-source {
    color: var(--fg-secondary);
}
.apikey-source.configured {
    color: #22c55e;
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
.vendor-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
.vendor-head .settings-group-title {
    margin-bottom: 0;
}
.setting-name-sub {
    color: var(--fg-tertiary);
    font-weight: 400;
}
.setting-badge.soft {
    background: var(--bg-hover);
    color: var(--fg-secondary);
}
.model-block {
    margin-top: 6px;
}
.provider-apikey {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
}
.provider-apikey .setting-input.wide {
    width: 100%;
    max-width: none;
    flex: 1;
}
.provider-apikey-label {
    font-size: 12px;
    color: var(--fg-secondary);
    flex-shrink: 0;
}
.model-price {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
}
.price-badge {
    font-size: 11px;
    font-family: ui-monospace, monospace;
    border-radius: 4px;
    padding: 2px 7px;
    border: 1px solid var(--border-soft);
}
.price-badge.idle {
    color: var(--fg-secondary);
    background: var(--bg-hover);
}
.price-badge.peak {
    color: #d97706;
    background: rgba(217, 119, 6, 0.1);
    border-color: rgba(217, 119, 6, 0.3);
}
</style>
