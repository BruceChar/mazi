<script setup>
/**
 * SkillsPanel — 设置 → Skills：Skill（SKILL.md）发现 / 新建 / 挂载 / 卸载 / 使用情况。
 *
 * 一个 Skill = 一个目录 + SKILL.md（frontmatter name/description + 正文指令）。
 * 挂载只决定「是否把该 Skill 的 name/description/路径放进每次运行的目录（渐进披露 L1）」；
 * 正文由模型按需用已有工具读取，Skill 不注册工具、不改变权限。
 * 契约见 docs/能力包规范.md §3–§6。
 */
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';

const skills = ref([]);
const roots = ref([]);
const loadErrors = ref([]);
const shadowed = ref([]);
const summary = ref({ discovered: 0, mounted: 0, injections: 0 });
const busy = ref('');
const message = ref('');
const error = ref('');
const loading = ref(true);
const expanded = ref('');
const details = ref({});
const createOpen = ref(false);
const creating = ref(false);
const form = reactive({
    id: '',
    name: '',
    description: '',
    scope: 'user',
    whenToUse: '',
    steps: '',
    output: '',
    notes: '',
});

const SCOPE_LABELS = { project: '项目', user: '用户', builtin: '内置' };

function scopeLabel(scope) {
    return SCOPE_LABELS[scope] || scope;
}
function timeOf(ts) {
    return ts ? new Date(ts).toLocaleString() : '';
}
function sizeOf(bytes) {
    return bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
}

function apply(data) {
    skills.value = data.skills || [];
    roots.value = data.roots || [];
    loadErrors.value = data.errors || [];
    shadowed.value = data.shadowed || [];
    summary.value = data.usage || summary.value;
}

async function load(reload) {
    error.value = '';
    try {
        const data = reload
            ? await api('/api/capabilities/reload', { method: 'POST' })
            : await api('/api/capabilities');
        apply(data);
        message.value = reload ? '已重新扫描 skills 根' : '';
    } catch (e) {
        error.value = String(e);
    } finally {
        loading.value = false;
    }
}

async function create() {
    creating.value = true;
    error.value = '';
    try {
        const created = await api('/api/capabilities', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                id: form.id,
                name: form.name,
                description: form.description,
                scope: form.scope,
                whenToUse: form.whenToUse,
                steps: form.steps,
                output: form.output,
                notes: form.notes,
            }),
        });
        message.value = '已创建 ' + created.id + '（' + created.path + '）';
        form.id = '';
        form.name = '';
        form.description = '';
        form.whenToUse = '';
        form.steps = '';
        form.output = '';
        form.notes = '';
        createOpen.value = false;
        await load(false);
    } catch (e) {
        error.value = String(e);
    } finally {
        creating.value = false;
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
                    一个 Skill 就是一个含 <code>SKILL.md</code> 的目录（frontmatter + 指令正文）。
                    挂载后其名称与描述会进入会话目录，模型按需读取正文；Skill 不注册工具、不改动权限。
                </p>
            </div>
            <div class="skills-head-actions">
                <button class="skills-btn" @click="createOpen = !createOpen">新建技能</button>
                <button class="skills-btn" :disabled="busy !== ''" @click="load(true)">
                    重新扫描
                </button>
            </div>
        </div>

        <div class="skills-summary">
            <span>已挂载 <strong>{{ summary.mounted }}</strong> / {{ summary.discovered }}</span>
            <span>目录注入 {{ summary.injections }} 次</span>
        </div>

        <div v-if="createOpen" class="skills-create">
            <div class="skills-create-row">
                <input v-model="form.id" class="skills-input" placeholder="id（kebab-case，如 my-skill）" />
                <input v-model="form.name" class="skills-input" placeholder="显示名" />
                <select v-model="form.scope" class="skills-input skills-select">
                    <option value="user">用户目录</option>
                    <option value="project">项目目录</option>
                </select>
                <button
                    class="skills-btn primary"
                    :disabled="creating || !form.id.trim() || !form.name.trim() || !form.description.trim()"
                    @click="create"
                >
                    {{ creating ? '创建中…' : '创建' }}
                </button>
            </div>
            <input v-model="form.description" class="skills-input" placeholder="description（必填）：做什么 + 什么时候用 —— 模型据此判断是否加载本 Skill" />
            <div class="skills-form-grid">
                <label class="skills-field">
                    <span class="skills-field-label">何时使用（trigger）</span>
                    <textarea
                        v-model="form.whenToUse"
                        class="skills-textarea"
                        rows="3"
                        placeholder="写清触发场景与典型请求，例如：用户说「今天做到了什么」「帮我复盘这周」时使用。多行会转为列表。"
                    ></textarea>
                </label>
                <label class="skills-field">
                    <span class="skills-field-label">步骤（每行一步）</span>
                    <textarea
                        v-model="form.steps"
                        class="skills-textarea"
                        rows="4"
                        placeholder="先读 references/format.md 确认结构&#10;向用户追问事实—感受—下一步&#10;写入用户指定文件"
                    ></textarea>
                </label>
                <label class="skills-field">
                    <span class="skills-field-label">输出（每行一条）</span>
                    <textarea
                        v-model="form.output"
                        class="skills-textarea"
                        rows="3"
                        placeholder="三段式：事实 / 感受 / 下一步&#10;不编造用户未提供的事实"
                    ></textarea>
                </label>
                <label class="skills-field">
                    <span class="skills-field-label">注意事项（可选，每行一条）</span>
                    <textarea
                        v-model="form.notes"
                        class="skills-textarea"
                        rows="3"
                        placeholder="敏感内容不写入公开文件&#10;单日最多 3 条"
                    ></textarea>
                </label>
            </div>
            <p class="skills-hint">
                将写入 <code>&lt;skills 根&gt;/&lt;id&gt;/SKILL.md</code>：frontmatter（name/description）+ 上述分栏组成的正文；
                全部留空则落一份带占位提示的骨架。
            </p>
        </div>

        <div class="skills-roots">
            <span v-for="root in roots" :key="root.dir" class="skills-root">
                <span class="skills-scope">{{ scopeLabel(root.scope) }}</span>
                <code>{{ root.dir }}</code>
            </span>
        </div>

        <div v-if="message" class="skills-msg">{{ message }}</div>
        <div v-if="error" class="skills-error">{{ error }}</div>

        <div v-if="loadErrors.length" class="skills-errors">
            <div class="skills-errors-title">装载错误（{{ loadErrors.length }}）</div>
            <div v-for="entry in loadErrors" :key="entry.skillId + entry.dir" class="skills-error-row">
                <strong>{{ entry.skillId }}</strong>
                <span class="skills-error-dir">{{ scopeLabel(entry.scope) }} · {{ entry.dir }}</span>
                <span v-for="issue in entry.issues" :key="issue.path + issue.code" class="skills-issue">
                    {{ issue.code }} @ {{ issue.path }}：{{ issue.message }}
                </span>
            </div>
        </div>

        <div v-if="shadowed.length" class="skills-msg">
            同名覆盖：
            <span v-for="item in shadowed" :key="item.skillId">
                {{ item.skillId }}（{{ scopeLabel(item.scope) }} 被 {{ item.shadowedBy }} 覆盖）
            </span>
        </div>

        <div v-if="loading" class="skills-empty">加载中…</div>
        <div v-else-if="skills.length === 0" class="skills-empty">
            尚未发现 Skill。点「新建技能」生成 SKILL.md，或把 &lt;id&gt;/SKILL.md 放进 skills 目录后点「重新扫描」。
        </div>

        <div v-else class="skills-list">
            <div
                v-for="skill in skills"
                :key="skill.id"
                class="skills-card"
                :class="{ mounted: skill.mounted }"
            >
                <div class="skills-row">
                    <button class="skills-name" @click="toggleDetail(skill)">
                        {{ skill.name }}
                        <span class="skills-id">{{ skill.id }} · {{ sizeOf(skill.bytes) }}</span>
                    </button>
                    <span v-if="skill.mounted" class="skills-badge">已挂载</span>
                    <span class="skills-scope">{{ scopeLabel(skill.scope) }}</span>
                    <span v-if="skill.resourceCount" class="skills-tools">{{ skill.resourceCount }} 随包文件</span>
                    <button
                        class="skills-btn"
                        :class="{ mounted: skill.mounted }"
                        :disabled="busy !== ''"
                        @click="toggle(skill)"
                    >
                        {{ skill.mounted ? '卸载' : '挂载' }}
                    </button>
                </div>
                <div class="skills-desc">{{ skill.description }}</div>
                <div class="skills-usage">
                    <span>目录注入 {{ skill.usage.injections }} 次</span>
                    <span v-if="skill.usage.lastInjectedAt">最近 {{ timeOf(skill.usage.lastInjectedAt) }}</span>
                    <span v-if="skill.mounted && skill.mountedAt">挂载于 {{ timeOf(skill.mountedAt) }}</span>
                    <span v-if="skill.allowedTools.length">allowed-tools: {{ skill.allowedTools.join(' ') }}</span>
                </div>
                <div v-if="expanded === skill.id" class="skills-detail">
                    <template v-if="details[skill.id]">
                        <div class="skills-detail-block">
                            <span class="skills-detail-label">路径</span>
                            <code>{{ details[skill.id].path }}</code>
                        </div>
                        <div v-if="details[skill.id].frontmatter.whenToUse" class="skills-detail-block">
                            <span class="skills-detail-label">when_to_use</span>
                            <span>{{ details[skill.id].frontmatter.whenToUse }}</span>
                        </div>
                        <div v-if="details[skill.id].frontmatter.license" class="skills-detail-block">
                            <span class="skills-detail-label">license</span>
                            <span>{{ details[skill.id].frontmatter.license }}</span>
                        </div>
                        <div v-if="details[skill.id].resources.length" class="skills-detail-block">
                            <span class="skills-detail-label">随包文件</span>
                            <code v-for="resource in details[skill.id].resources" :key="resource">
                                {{ resource }}
                            </code>
                        </div>
                        <pre class="skills-body">{{ details[skill.id].body }}</pre>
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
.skills-head-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}
.skills-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.skills-summary strong {
    color: var(--fg);
}
.skills-create {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
}
.skills-create-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.skills-form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
}
.skills-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.skills-field-label {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.skills-textarea {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font-size: 12px;
    line-height: 1.5;
    resize: vertical;
    font-family: inherit;
}
.skills-input {
    flex: 1;
    min-width: 120px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font-size: 12px;
}
.skills-select {
    flex: 0 0 auto;
    min-width: 96px;
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
.skills-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--accent);
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
.skills-card.mounted {
    border-color: var(--accent);
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
.skills-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
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
.skills-usage {
    margin-top: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11px;
    color: var(--fg-tertiary);
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
    width: 84px;
    color: var(--fg-tertiary);
}
.skills-body {
    margin: 4px 0 0;
    padding: 8px;
    max-height: 320px;
    overflow: auto;
    background: var(--bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    color: var(--fg);
}
</style>
