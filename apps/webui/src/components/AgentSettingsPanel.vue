<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';

const packs = ref([]);
const roles = ref([]);
const prompts = ref([]);
/** 每个 Agent 的编辑草稿；初始为实际生效文本（未配置时即内置默认）。 */
const promptDrafts = ref({});
const verifier = ref(null);
const loading = ref(false);
const error = ref('');
const notice = ref('');
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
const roleForm = ref({
    roleId: '',
    label: '',
    tools: 'fs.read, rg',
    systemPrompt: '',
    defaultCeiling: 'read-only',
    memoryPolicy: 'inherit',
});

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

async function saveRole() {
    error.value = '';
    notice.value = '';
    try {
        await api('/api/agent/roles', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                roleId: roleForm.value.roleId.trim(),
                label: roleForm.value.label.trim(),
                tools: roleForm.value.tools
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                systemPrompt: roleForm.value.systemPrompt.trim(),
                defaultCeiling: roleForm.value.defaultCeiling,
                memoryPolicy: roleForm.value.memoryPolicy,
            }),
        });
        notice.value = 'Agent 角色模板已保存。';
        await load();
    } catch (err) {
        error.value = String(err);
    }
}

async function removeRole(id) {
    try {
        await api(`/api/agent/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await load();
    } catch (err) {
        error.value = String(err);
    }
}
</script>

<template>
    <div class="agent-settings">
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
            Agent 编排、Replan 和委派由 Harness 自动执行。这里只维护可复用的模板与模式，
            不需要用户逐步操作 Agent。
        </p>
        <p v-if="error" class="agent-message error">{{ error }}</p>
        <p v-if="notice" class="agent-message ok">{{ notice }}</p>

        <section class="agent-section">
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

        <section class="agent-section">
            <div class="agent-section-head">
                <h3>PromptPack 模板</h3>
                <span>{{ packs.length }} 个</span>
            </div>
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

        <section class="agent-section">
            <div class="agent-section-head">
                <h3>Agent 角色模板</h3>
                <span>{{ roles.length }} 个</span>
            </div>
            <div class="agent-item-list">
                <div v-for="role in roles" :key="role.roleId" class="agent-item">
                    <div>
                        <strong>{{ role.label }}</strong>
                        <code>{{ role.roleId }} · {{ role.defaultCeiling || 'inherit' }}</code>
                        <p>{{ role.systemPrompt || '未单独设置系统提示' }}</p>
                    </div>
                    <button type="button" @click="removeRole(role.roleId)">删除</button>
                </div>
            </div>
            <div class="agent-form">
                <input v-model="roleForm.roleId" placeholder="角色 id" />
                <input v-model="roleForm.label" placeholder="显示名称" />
                <input v-model="roleForm.tools" placeholder="允许工具，逗号分隔" />
                <select v-model="roleForm.defaultCeiling">
                    <option value="read-only">read-only</option>
                    <option value="workspace-write">workspace-write</option>
                    <option value="draft">draft</option>
                    <option value="approved">approved</option>
                </select>
                <select v-model="roleForm.memoryPolicy">
                    <option value="inherit">inherit memory</option>
                    <option value="isolated">isolated memory</option>
                </select>
                <textarea v-model="roleForm.systemPrompt" rows="3" placeholder="角色模板正文"></textarea>
                <button class="primary" type="button" @click="saveRole">保存角色</button>
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
.agent-modes {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}
.agent-modes div {
    display: flex;
    flex-direction: column;
    gap: 3px;
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
    margin: 0;
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
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    padding: 10px;
}
.agent-section-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
}
.agent-section-head h3 {
    margin: 0;
    font-size: 13px;
}
.agent-item-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
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
.agent-item button:hover {
    color: var(--error);
}
.agent-form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 9px;
    padding-top: 9px;
    border-top: 1px solid var(--border-soft);
}
.agent-form input,
.agent-form select,
.agent-form textarea {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    padding: 6px 8px;
    font: inherit;
    font-size: 11px;
    resize: vertical;
}
.agent-form textarea,
.agent-form .primary {
    grid-column: 1 / -1;
}
.agent-form .primary {
    justify-self: end;
    background: var(--accent);
    color: #fff;
    border-color: transparent;
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
@media (max-width: 700px) {
    .agent-modes,
    .agent-form {
        grid-template-columns: 1fr;
    }
}
</style>
