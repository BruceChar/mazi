<script setup>
/**
 * SkillsPanel — 设置 → Skills：技能（能力包）发现与挂载/卸载。
 *
 * 技能是用户资产：目录在 $MAZI_HOME/skills（用户级）与 <workspace>/skills（项目级），
 * 不进代码仓库。面板只做「发现 → 挂载 → 使用 / 卸载」，挂载状态由后端持久化。
 * 契约见 docs/能力包规范.md §10。
 */
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const skills = ref([]);
const roots = ref([]);
const loadErrors = ref([]);
const shadowed = ref([]);
const busy = ref('');
const message = ref('');
const error = ref('');
const loading = ref(true);
const expanded = ref('');
const details = ref({});

const CEILING_LABELS = {
    text: '仅文本',
    'read-only': '只读',
    'workspace-write': '工作区写',
    draft: '草稿',
    approved: '需审批',
    autonomous: '自治',
};

function ceilingLabel(level) {
    return CEILING_LABELS[level] || level;
}

async function load(reload) {
    error.value = '';
    try {
        const data = reload
            ? await api('/api/capabilities/reload', { method: 'POST' })
            : await api('/api/capabilities');
        skills.value = data.skills || [];
        roots.value = data.roots || [];
        loadErrors.value = data.errors || [];
        shadowed.value = data.shadowed || [];
        message.value = reload ? '已重新扫描 skills 根' : '';
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

async function toggle(skill) {
    busy.value = skill.id;
    error.value = '';
    try {
        const action = skill.mounted ? 'unmount' : 'mount';
        await api('/api/capabilities/' + encodeURIComponent(skill.id) + '/' + action, {
            method: 'POST',
        });
        message.value = skill.mounted ? '已卸载 ' + skill.name : '已挂载 ' + skill.name;
        await load(false);
    } catch (e) {
        error.value = String(e);
    } finally {
        busy.value = '';
    }
}

async function toggleDetail(skill) {
    if (expanded.value === skill.id) {
        expanded.value = '';
        return;
    }
    expanded.value = skill.id;
    if (details.value[skill.id]) return;
    try {
        details.value = {
            ...details.value,
            [skill.id]: await api('/api/capabilities/' + encodeURIComponent(skill.id)),
        };
    } catch (e) {
        error.value = String(e);
    }
}

onMounted(() => load(false));
</script>

<template>
    <div class="skills-panel">
        <div class="skills-head">
            <div>
                <h3>技能（Skills）</h3>
                <p class="skills-hint">
                    技能包放在用户目录或项目目录的 <code>skills/</code> 下，系统自动发现；
                    挂载后其工具并入会话执行面，卸载立即失效。
                </p>
            </div>
            <button class="skills-btn" :disabled="busy !== ''" @click="load(true)">
                重新扫描
            </button>
        </div>

        <div class="skills-roots">
            <span v-for="root in roots" :key="root.dir" class="skills-root">
                <span class="skills-scope">{{ root.scope === 'project' ? '项目' : '用户' }}</span>
                <code>{{ root.dir }}</code>
            </span>
        </div>

        <div v-if="message" class="skills-msg">{{ message }}</div>
        <div v-if="error" class="skills-error">{{ error }}</div>

        <div v-if="loadErrors.length" class="skills-errors">
            <div class="skills-errors-title">装载错误（{{ loadErrors.length }}）</div>
            <div v-for="entry in loadErrors" :key="entry.skillId + entry.dir" class="skills-error-row">
                <strong>{{ entry.skillId || '(根)' }}</strong>
                <span class="skills-error-dir">{{ entry.dir }}</span>
                <span v-for="issue in entry.issues" :key="issue.path + issue.code" class="skills-issue">
                    {{ issue.code }} @ {{ issue.path }}：{{ issue.message }}
                </span>
            </div>
        </div>

        <div v-if="shadowed.length" class="skills-msg">
            项目级覆盖：
            <span v-for="item in shadowed" :key="item.skillId">
                {{ item.skillId }}（{{ item.shadowedBy }}）
            </span>
        </div>

        <div v-if="loading" class="skills-empty">加载中…</div>
        <div v-else-if="skills.length === 0" class="skills-empty">
            尚未发现技能。在 skills 目录放入 &lt;id&gt;/manifest.json 后点「重新扫描」。
        </div>

        <div v-else class="skills-list">
            <div v-for="skill in skills" :key="skill.id" class="skills-card">
                <div class="skills-row">
                    <button class="skills-name" @click="toggleDetail(skill)">
                        {{ skill.name }}
                        <span class="skills-id">{{ skill.id }} · v{{ skill.version }}</span>
                    </button>
                    <span class="skills-scope">{{ skill.scope === 'project' ? '项目' : '用户' }}</span>
                    <span class="skills-ceiling">上限 {{ ceilingLabel(skill.permissionCeiling) }}</span>
                    <span class="skills-tools">{{ skill.toolNames.length }} 工具</span>
                    <button
                        class="skills-btn"
                        :class="{ mounted: skill.mounted }"
                        :disabled="busy !== ''"
                        @click="toggle(skill)"
                    >
                        {{ skill.mounted ? '卸载' : '挂载' }}
                    </button>
                </div>
                <div v-if="skill.description" class="skills-desc">{{ skill.description }}</div>
                <div v-if="expanded === skill.id" class="skills-detail">
                    <template v-if="details[skill.id]">
                        <div class="skills-detail-block">
                            <span class="skills-detail-label">工具</span>
                            <span v-if="details[skill.id].tools.length === 0">（无）</span>
                            <code v-for="tool in details[skill.id].tools" :key="tool.name">
                                {{ tool.name }} · {{ tool.minPermission }} ·
                                {{ (tool.sideEffects || []).join('/') || 'no-effect' }}
                            </code>
                        </div>
                        <div class="skills-detail-block">
                            <span class="skills-detail-label">记忆</span>
                            <span v-if="details[skill.id].memory.collections.length === 0">（无）</span>
                            <code v-for="collection in details[skill.id].memory.collections" :key="collection.name">
                                {{ collection.name }} · {{ collection.sensitivity || 'normal' }}
                            </code>
                        </div>
                        <div class="skills-detail-block">
                            <span class="skills-detail-label">模板 / 校验器</span>
                            <code>{{ details[skill.id].templates.join(', ') || '（无）' }}</code>
                            <code>{{ details[skill.id].validators.join(', ') || '（无）' }}</code>
                        </div>
                        <div class="skills-detail-block">
                            <span class="skills-detail-label">事件</span>
                            <code>emits: {{ details[skill.id].events.emits.join(', ') || '（无）' }}</code>
                            <code>subscribes: {{ details[skill.id].events.subscribes.join(', ') || '（无）' }}</code>
                        </div>
                    </template>
                    <span v-else>加载中…</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.skills-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.skills-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
}
.skills-head h3 {
    margin: 0 0 4px;
    font-size: 14px;
    color: var(--fg);
}
.skills-hint {
    margin: 0;
    font-size: 12px;
    color: var(--fg-tertiary);
    line-height: 1.5;
}
.skills-roots {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.skills-root {
    display: flex;
    align-items: center;
    gap: 8px;
}
.skills-scope {
    flex-shrink: 0;
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--fg-secondary);
}
.skills-msg {
    font-size: 12px;
    color: var(--fg-secondary);
}
.skills-error {
    font-size: 12px;
    color: var(--warn);
}
.skills-errors {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.skills-errors-title {
    font-weight: 600;
    color: var(--warn);
    margin-bottom: 4px;
}
.skills-error-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 0;
    border-top: 1px solid var(--border-soft);
}
.skills-error-dir,
.skills-issue {
    color: var(--fg-tertiary);
}
.skills-empty {
    padding: 16px 0;
    font-size: 13px;
    color: var(--fg-tertiary);
}
.skills-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.skills-card {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 8px 10px;
}
.skills-row {
    display: flex;
    align-items: center;
    gap: 10px;
}
.skills-name {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
    padding: 0;
}
.skills-id {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.skills-ceiling,
.skills-tools {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.skills-btn {
    flex-shrink: 0;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-secondary);
    font-size: 12px;
    cursor: pointer;
}
.skills-btn:hover {
    background: var(--bg-hover);
    color: var(--fg);
}
.skills-btn.mounted {
    border-color: var(--accent);
    color: var(--accent);
}
.skills-btn:disabled {
    opacity: 0.5;
    cursor: default;
}
.skills-desc {
    margin-top: 4px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.skills-detail {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border-soft);
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.skills-detail-block {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}
.skills-detail-label {
    flex-shrink: 0;
    width: 72px;
    color: var(--fg-tertiary);
}
</style>
