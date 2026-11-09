<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import {
    buildRolePayload,
    emptyRoleForm,
    roleModelLabel,
    roleModelOptions,
    roleSummary,
    roleToForm,
    validateRolePayload,
} from '../scripts/agent-roles.ts';

const props = defineProps({
    /** 模型目录（与 Providers 页同源）；用于角色的默认模型选择。 */
    cfg: { type: Object, default: null },
    /** 当前会话选中的模型，作为「跟随会话默认」的展示值。 */
    selectedModel: { type: String, default: '' },
});

const packs = ref([]);
const roles = ref([]);
const prompts = ref([]);
/** 每个 Agent 的编辑草稿；初始为实际生效文本（未配置时即内置默认）。 */
const promptDrafts = ref({});
const verifier = ref(null);
const loading = ref(false);
const error = ref('');
const notice = ref('');
/** Agent 板块二级分区：概览 / 角色 / 系统提示 / 模板。 */
const tab = ref('overview');
const roleForm = ref(emptyRoleForm());
/** 正在编辑的角色 id；空串表示新建。 */
const editingRoleId = ref('');
/** 角色编辑面板是否展开（新建时 roleId 还是空的，不能拿它判断）。 */
const editorOpen = ref(false);
const packForm = ref({
    id: '',
    name: '',
    description: '',
    module: '',
    taskKind: 'coding',
    riskLevel: 'read-only',
    projectId: '',
    budgetTokens: 600,
});

const modelOptions = computed(() => roleModelOptions(props.cfg));
const modelGroups = computed(() => {
    const groups = new Map();
    for (const option of modelOptions.value) {
        if (!groups.has(option.group)) groups.set(option.group, []);
        groups.get(option.group).push(option);
    }
    return [...groups.entries()].map(([group, options]) => ({ group, options }));
});
const builtinRoleIds = new Set(['default', 'coding', 'planner', 'executor', 'reviewer', 'researcher']);
const defaultModelLabel = computed(() =>
    roleModelLabel(props.cfg, props.selectedModel || props.cfg?.model || undefined),
);

onMounted(load);

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const [packData, roleData, verifierData, promptData] = await Promise.all([
            api('/api/agent/prompt-packs'),
            api('/api/agent/roles'),
            api('/api/agent/verifier'),
            api('/api/agent/prompts'),
        ]);
        packs.value = packData.packs ?? [];
        roles.value = roleData.roles ?? [];
        verifier.value = verifierData;
        prompts.value = promptData.prompts ?? [];
        promptDrafts.value = Object.fromEntries(
            prompts.value.map((prompt) => [prompt.id, prompt.effectivePrompt]),
        );
    } catch (err) {
        error.value = String(err);
    } finally {
        loading.value = false;
    }
}

async function savePrompt(id) {
    error.value = '';
    notice.value = '';
    try {
        await api(`/api/agent/prompts/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ systemPrompt: promptDrafts.value[id] ?? '' }),
        });
        notice.value = '系统提示已保存；新会话按新提示装配，运行中的会话保持原提示。';
        await load();
    } catch (err) {
        error.value = String(err);
    }
}

async function resetPrompt(id) {
    error.value = '';
    notice.value = '';
    try {
        await api(`/api/agent/prompts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        notice.value = '已恢复内置默认提示；新会话生效。';
        await load();
    } catch (err) {
        error.value = String(err);
    }
}

function startCreateRole() {
    error.value = '';
    editingRoleId.value = '';
    roleForm.value = emptyRoleForm();
    editorOpen.value = true;
}

function startEditRole(role) {
    error.value = '';
    editingRoleId.value = role.roleId;
    roleForm.value = roleToForm(role);
    editorOpen.value = true;
}

function cancelRoleEdit() {
    editingRoleId.value = '';
    roleForm.value = emptyRoleForm();
    editorOpen.value = false;
}

async function saveRole() {
    error.value = '';
    notice.value = '';
    const payload = buildRolePayload(roleForm.value);
    const invalid = validateRolePayload(payload);
    if (invalid) {
        error.value = invalid;
        return;
    }
    try {
        const updating = editingRoleId.value !== '';
        const path = updating
            ? `/api/agent/roles/${encodeURIComponent(editingRoleId.value)}`
            : '/api/agent/roles';
        await api(path, {
            method: updating ? 'PUT' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        notice.value = updating ? 'Agent 角色已更新。' : 'Agent 角色已创建。';
        cancelRoleEdit();
        await load();
    } catch (err) {
        error.value = String(err);
    }
}

async function removeRole(id) {
    error.value = '';
    try {
        await api(`/api/agent/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (editingRoleId.value === id) cancelRoleEdit();
        await load();
    } catch (err) {
        error.value = String(err);
    }
}

async function savePack() {
    error.value = '';
    notice.value = '';
    try {
        await api('/api/agent/prompt-packs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                id: packForm.value.id.trim(),
                name: packForm.value.name.trim(),
                description: packForm.value.description.trim(),
                module: packForm.value.module.trim(),
                version: 1,
                matcher: {
                    taskKinds: [packForm.value.taskKind],
                    ...(packForm.value.projectId.trim()
                        ? { projectIds: [packForm.value.projectId.trim()] }
                        : {}),
                    riskLevels: [packForm.value.riskLevel],
                },
                budgetTokens: Number(packForm.value.budgetTokens) || 600,
            }),
        });
        notice.value = 'Agent 模板已保存；后续 SuperAgent 会按需匹配。';
        await load();
    } catch (err) {
        error.value = String(err);
    }
}

async function removePack(id) {
    try {
        await api(`/api/agent/prompt-packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await load();
    } catch (err) {
        error.value = String(err);
    }
}
</script>

<template>
    <div class="agent-settings">
        <div class="agent-tabs" role="tablist">
            <button
                v-for="item in [
                    { id: 'overview', label: '概览' },
                    { id: 'roles', label: `角色 ${roles.length}` },
                    { id: 'prompts', label: `系统提示 ${prompts.length}` },
                    { id: 'packs', label: `模板 ${packs.length}` },
                ]"
                :key="item.id"
                type="button"
                role="tab"
                class="agent-tab"
                :class="{ active: tab === item.id }"
                :aria-selected="tab === item.id"
                @click="tab = item.id"
            >
                {{ item.label }}
            </button>
        </div>

        <p v-if="error" class="agent-message error">{{ error }}</p>
        <p v-if="notice" class="agent-message ok">{{ notice }}</p>

        <!-- 概览：Harness 内部能力，只读 -->
        <section v-if="tab === 'overview'" class="agent-section">
            <div class="agent-section-head">
                <h3>运行期 Agent</h3>
                <span>只读</span>
            </div>
            <div class="agent-modes">
                <div>
                    <strong>SuperAgent</strong>
                    <span>自动选择最小 PromptPack 与执行角色</span>
                </div>
                <div>
                    <strong>Planner</strong>
                    <span>task-graph · 内部使用</span>
                </div>
                <div>
                    <strong>Verifier</strong>
                    <span>
                        {{ verifier?.id || 'independent-default' }} ·
                        {{ verifier?.semanticJudge ? '语义 Judge 已注入' : '机械验收' }}
                    </span>
                </div>
                <div>
                    <strong>Replan / Delegation</strong>
                    <span>Harness 内部能力，按权限和预算启用</span>
                </div>
            </div>
            <p class="agent-hint">
                Agent 编排、Replan 和委派由 Harness 自动执行。下面只维护可复用的角色与提示，
                不需要逐步操作 Agent。当前会话默认模型：<strong>{{ defaultModelLabel }}</strong>
            </p>
        </section>

        <!-- 角色：卡片栅格 + 新建/编辑 -->
        <section v-if="tab === 'roles'" class="agent-section">
            <div class="agent-section-head">
                <h3>Agent 角色</h3>
                <button class="agent-ghost" type="button" @click="startCreateRole">新建 Agent</button>
            </div>
            <p class="agent-hint">
                角色决定「谁来做、用什么模型、能碰哪些工具」。未指定模型的角色跟随会话默认模型。
            </p>
            <div v-if="!roles.length" class="agent-hint">还没有角色，先创建一个。</div>
            <div v-else class="agent-role-grid">
                <article v-for="role in roles" :key="role.roleId" class="agent-role-card">
                    <div class="agent-role-head">
                        <strong>{{ role.label }}</strong>
                        <span class="agent-badge soft">{{ builtinRoleIds.has(role.roleId) ? '内置' : '自定义' }}</span>
                    </div>
                    <code class="agent-role-id">{{ role.roleId }}</code>
                    <p class="agent-role-desc">{{ roleSummary(role) }}</p>
                    <div class="agent-role-badges">
                        <span class="agent-badge">{{ roleModelLabel(cfg, role.modelId) }}</span>
                        <span class="agent-badge">{{ role.defaultCeiling || 'inherit' }}</span>
                        <span class="agent-badge">{{ (role.tools || []).length }} 工具</span>
                        <span v-if="role.memoryPolicy === 'isolated'" class="agent-badge">独立记忆</span>
                    </div>
                    <div class="agent-role-actions">
                        <button type="button" @click="startEditRole(role)">编辑</button>
                        <button type="button" class="danger" @click="removeRole(role.roleId)">删除</button>
                    </div>
                </article>
            </div>

            <div class="agent-editor" :class="{ open: editorOpen }">
                <div class="agent-section-head">
                    <h3>{{ editingRoleId ? '编辑角色' : '新建角色' }}</h3>
                    <button class="agent-ghost" type="button" @click="cancelRoleEdit">取消</button>
                </div>
                <div class="agent-form">
                    <label>
                        角色 ID
                        <input
                            v-model="roleForm.roleId"
                            :disabled="editingRoleId !== ''"
                            placeholder="doc-writer"
                        />
                    </label>
                    <label>
                        显示名称
                        <input v-model="roleForm.label" placeholder="文档 Agent" />
                    </label>
                    <label class="span-2">
                        能力描述（SuperAgent 自动路由依据）
                        <input v-model="roleForm.description" placeholder="写文档、整理纪要、校对措辞" />
                    </label>
                    <label class="span-2">
                        默认模型
                        <select v-model="roleForm.modelId">
                            <option value="">跟随会话默认（{{ defaultModelLabel }}）</option>
                            <optgroup
                                v-for="group in modelGroups"
                                :key="group.group"
                                :label="group.group"
                            >
                                <option
                                    v-for="option in group.options"
                                    :key="option.value"
                                    :value="option.value"
                                >
                                    {{ option.label }}
                                </option>
                            </optgroup>
                        </select>
                    </label>
                    <label>
                        权限档
                        <select v-model="roleForm.defaultCeiling">
                            <option value="read-only">read-only</option>
                            <option value="workspace-write">workspace-write</option>
                            <option value="draft">draft</option>
                            <option value="approved">approved</option>
                        </select>
                    </label>
                    <label>
                        记忆策略
                        <select v-model="roleForm.memoryPolicy">
                            <option value="inherit">inherit memory</option>
                            <option value="isolated">isolated memory</option>
                        </select>
                    </label>
                    <label class="span-2">
                        允许工具（逗号分隔）
                        <input v-model="roleForm.tools" placeholder="fs.read, rg, sd" />
                    </label>
                    <label class="span-2">
                        角色系统提示（留空则使用「系统提示」分区里对应配置）
                        <textarea v-model="roleForm.systemPrompt" rows="3"></textarea>
                    </label>
                    <div class="agent-form-footer">
                        <button class="primary" type="button" @click="saveRole">
                            {{ editingRoleId ? '保存修改' : '创建角色' }}
                        </button>
                    </div>
                </div>
            </div>
        </section>

        <!-- 系统提示 -->
        <section v-if="tab === 'prompts'" class="agent-section">
            <div class="agent-section-head">
                <h3>SystemPrompt 配置</h3>
                <span>{{ prompts.length }} 个 Agent</span>
            </div>
            <p class="agent-hint">
                配置优先于代码默认；保存后<strong>新会话</strong>按新提示装配，运行中的会话保持创建时的提示。
            </p>
            <div class="agent-item-list">
                <details v-for="prompt in prompts" :key="prompt.id" class="agent-prompt">
                    <summary>
                        <span>{{ prompt.label }}</span>
                        <code>{{ prompt.id }}</code>
                        <span
                            class="agent-prompt-badge"
                            :class="prompt.source === 'config' ? 'configured' : 'default'"
                        >
                            {{ prompt.source === 'config' ? '已配置' : '默认' }}
                        </span>
                    </summary>
                    <p class="agent-hint">{{ prompt.description }}</p>
                    <textarea
                        v-model="promptDrafts[prompt.id]"
                        rows="6"
                        spellcheck="false"
                        placeholder="留空保存即恢复内置默认"
                    ></textarea>
                    <div class="agent-prompt-actions">
                        <button type="button" @click="resetPrompt(prompt.id)">恢复默认</button>
                        <button class="primary" type="button" @click="savePrompt(prompt.id)">
                            保存
                        </button>
                    </div>
                </details>
            </div>
        </section>

        <!-- 模板 -->
        <section v-if="tab === 'packs'" class="agent-section">
            <div class="agent-section-head">
                <h3>PromptPack 模板</h3>
                <span>{{ packs.length }} 个</span>
            </div>
            <p class="agent-hint">按任务类型注入的提示包，供 SuperAgent 自动匹配；高级用法，默认折叠维护。</p>
            <div class="agent-item-list">
                <div v-for="pack in packs" :key="pack.id" class="agent-item">
                    <div>
                        <strong>{{ pack.name }}</strong>
                        <code>{{ pack.id }}@v{{ pack.version }}</code>
                        <p>{{ pack.description }}</p>
                    </div>
                    <button type="button" @click="removePack(pack.id)">删除</button>
                </div>
            </div>
            <div class="agent-form">
                <input v-model="packForm.id" placeholder="模板 id" />
                <input v-model="packForm.name" placeholder="显示名称" />
                <input v-model="packForm.description" placeholder="用途说明" />
                <select v-model="packForm.taskKind">
                    <option value="general">general</option>
                    <option value="coding">coding</option>
                    <option value="debug">debug</option>
                    <option value="research">research</option>
                    <option value="data">data</option>
                    <option value="memory">memory</option>
                    <option value="security">security</option>
                </select>
                <select v-model="packForm.riskLevel">
                    <option value="read-only">read-only</option>
                    <option value="workspace-write">workspace-write</option>
                    <option value="external">external</option>
                    <option value="irreversible">irreversible</option>
                </select>
                <input v-model="packForm.projectId" placeholder="限定项目（可选）" />
                <input v-model.number="packForm.budgetTokens" type="number" placeholder="Token 预算" />
                <textarea v-model="packForm.module" rows="4" placeholder="按需注入的模板正文"></textarea>
                <button class="primary" type="button" @click="savePack">保存模板</button>
            </div>
        </section>
    </div>
</template>

<style scoped>
.agent-settings {
    display: flex;
    flex-direction: column;
    gap: 14px;
}
/* 二级分区：窄屏横向滚动，不换行挤压 */
.agent-tabs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: thin;
}
.agent-tab {
    flex: 0 0 auto;
    padding: 6px 12px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: var(--bg-panel);
    color: var(--fg-secondary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
}
.agent-tab:hover,
.agent-tab:focus-visible {
    border-color: var(--accent);
    color: var(--fg);
}
.agent-tab.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 500;
}
.agent-modes {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 8px;
}
.agent-modes div {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
}
.agent-modes strong {
    font-size: 12px;
}
.agent-modes span,
.agent-hint,
.agent-section-head span,
.agent-item code,
.agent-item p {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.agent-hint {
    margin: 8px 0 0;
    line-height: 1.55;
}
.agent-message {
    margin: 0;
    font-size: 12px;
}
.agent-message.error {
    color: var(--error);
}
.agent-message.ok {
    color: var(--ok);
}
.agent-section {
    min-width: 0;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    padding: 10px;
}
.agent-section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
.agent-section-head h3 {
    margin: 0;
    font-size: 13px;
}
.agent-ghost {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg-secondary);
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
}
.agent-ghost:hover {
    border-color: var(--accent);
    color: var(--accent);
}
/* 角色卡：窄屏自动降列，最后一行不足时拉伸 */
.agent-role-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 8px;
    margin-top: 8px;
}
.agent-role-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.agent-role-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}
.agent-role-head strong {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.agent-role-id {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.agent-role-desc {
    margin: 2px 0 0;
    font-size: 11px;
    line-height: 1.45;
    color: var(--fg-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.agent-role-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 2px;
}
.agent-badge {
    padding: 1px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    font-size: 10px;
    color: var(--fg-secondary);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.agent-badge.soft {
    color: var(--fg-tertiary);
    background: var(--bg-hover);
}
.agent-role-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: auto;
    padding-top: 6px;
}
.agent-role-actions button,
.agent-item button,
.agent-form button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg-secondary);
    padding: 4px 8px;
    font-size: 11px;
    cursor: pointer;
}
.agent-role-actions button:hover {
    border-color: var(--accent);
    color: var(--accent);
}
.agent-role-actions button.danger:hover,
.agent-item button:hover {
    border-color: var(--error);
    color: var(--error);
}
/* 编辑面板：默认收起，进入新建/编辑时展开 */
.agent-editor {
    display: none;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border-soft);
}
.agent-editor.open {
    display: block;
}
.agent-form {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 8px;
    align-items: end;
}
.agent-form label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    font-size: 11px;
    color: var(--fg-secondary);
}
.agent-form .span-2 {
    grid-column: 1 / -1;
}
.agent-form input,
.agent-form select,
.agent-form textarea {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
    font-size: 11px;
    resize: vertical;
}
.agent-form textarea {
    grid-column: 1 / -1;
}
.agent-form-footer {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
}
.agent-form .primary {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
    padding: 6px 14px;
}
.agent-item-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 8px;
}
.agent-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 7px;
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.agent-item > div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.agent-item p {
    margin: 3px 0 0;
    line-height: 1.45;
}
.agent-prompt {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
    padding: 8px;
}
.agent-prompt summary {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 12px;
}
.agent-prompt summary code {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.agent-prompt-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 10px;
}
.agent-prompt-badge.configured {
    color: var(--ok);
    border-color: var(--ok);
}
.agent-prompt-badge.default {
    color: var(--fg-tertiary);
}
.agent-prompt textarea {
    box-sizing: border-box;
    width: 100%;
    margin-top: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 8px;
    font: inherit;
    font-size: 11px;
    line-height: 1.5;
    resize: vertical;
}
.agent-prompt-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
}
.agent-prompt-actions button {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg-secondary);
    padding: 4px 8px;
    font-size: 11px;
    cursor: pointer;
}
.agent-prompt-actions .primary {
    background: var(--accent);
    color: #fff;
    border-color: transparent;
}
/* 窄屏：角色卡单列，表单控件占满整行 */
@media (max-width: 640px) {
    .agent-role-grid,
    .agent-form {
        grid-template-columns: 1fr;
    }
    .agent-role-actions {
        justify-content: flex-start;
    }
}
</style>
